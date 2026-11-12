import { createReadStream } from "node:fs";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";

import { serveStatic } from "@hono/node-server/serve-static";
import { ORPCError } from "@orpc/client";
import { SmartCoercionPlugin } from "@orpc/json-schema";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { type Context, type Handler, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";

import { type Auth, authRoutes, findApiUser } from "../auth/auth";
import { isLocalHostname } from "../auth/config";
import { RateLimiter } from "../rateLimiter";
import type { RunnerPackage } from "../runnerPackage";
import { hasValidSignature } from "../secrets";
import type { Services } from "../services";
import { mapServiceErrors } from "./errorInterceptor";
import { router } from "./router";

const handler = new OpenAPIHandler(router, {
  clientInterceptors: [mapServiceErrors],
  plugins: [new SmartCoercionPlugin({ schemaConverters: [new ZodToJsonSchemaConverter()] })],
});

const errorBody = (code: string, message: string) => new ORPCError(code, { message }).toJSON();

// `@hono/node-server` puts the Node request in `env`; a test calls `fetch` without one.
const remoteAddress = (c: Context) =>
  (c.env as { incoming?: IncomingMessage } | undefined)?.incoming?.socket.remoteAddress ?? "";

// A device-flow poll every 5 s uses 12 of the 60 calls a minute.
const addressRateLimit = (trustedProxy: string | undefined): MiddlewareHandler => {
  const limiter = new RateLimiter(trustedProxy);
  return async (c, next) => {
    const { isAllowed, retryAfterSeconds } = limiter.take(
      remoteAddress(c),
      c.req.header("x-forwarded-for"),
    );
    if (!isAllowed) {
      c.header("Retry-After", String(retryAfterSeconds));
      return c.json(
        errorBody(
          "TOO_MANY_REQUESTS",
          "There are too many requests from this address. Try again in a minute.",
        ),
        429,
      );
    }
    await next();
  };
};

// A web page form cannot send JSON.
const jsonWritesOnly: MiddlewareHandler = async (c, next) => {
  const mediaType = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (c.req.method !== "GET" && mediaType !== "application/json") {
    return c.json(
      errorBody("UNSUPPORTED_MEDIA_TYPE", "Send the request with Content-Type: application/json"),
      415,
    );
  }
  await next();
};

// No login: refuse a foreign `Host` (DNS rebinding); `@hono/node-server` builds the URL from it.
const localHostOnly =
  (port: () => number): MiddlewareHandler =>
  async (c, next) => {
    const url = new URL(c.req.url);
    if (!isLocalHostname(url.hostname) || Number(url.port || 80) !== port()) {
      return c.json(errorBody("FORBIDDEN", `The server does not accept the host ${url.host}`), 403);
    }
    await next();
  };

// The largest payload that GitHub sends.
const maxDeliveryBytes = 25 * 1024 * 1024;

const receiveGitHubDelivery =
  (services: Services): Handler =>
  async (c) => {
    const secret = await services.gitHubApp.webhookSecret();
    if (secret === undefined) return c.notFound();
    const body = Buffer.from(await c.req.arrayBuffer());
    if (!hasValidSignature(secret, body, c.req.header("x-hub-signature-256"))) {
      return c.json(errorBody("UNAUTHORIZED", "The signature of this delivery is not valid"), 401);
    }
    const deliveryId = c.req.header("x-github-delivery");
    const event = c.req.header("x-github-event");
    if (!deliveryId || !event) {
      return c.json(errorBody("BAD_REQUEST", "This delivery has no id or no event"), 400);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString());
    } catch {
      return c.json(errorBody("BAD_REQUEST", "The body of this delivery is not JSON"), 400);
    }
    await services.gitHubDelivery.receive(deliveryId, event, payload);
    return c.body(null, 202);
  };

// The index names the hashed files, so a browser must not keep an old one after an upgrade.
const revalidateIndex: MiddlewareHandler = async (c, next) => {
  await next();
  if (c.res.headers.get("content-type")?.startsWith("text/html")) {
    c.header("Cache-Control", "no-cache");
  }
};

// A framing page can put a decoy over the Approve button of a login or a runner.
const refuseFrames: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("Content-Security-Policy", "frame-ancestors 'none'");
  c.header("X-Frame-Options", "DENY");
};

const isApiPath = (path: string) => path === "/api" || path.startsWith("/api/");

const serveRunnerPackage =
  (runnerPackage: RunnerPackage | undefined): Handler =>
  (c) => {
    if (!runnerPackage) {
      return c.json(errorBody("NOT_FOUND", "This server has no package for runners"), 404);
    }
    c.header("Content-Type", "application/gzip");
    c.header("Content-Length", String(runnerPackage.size));
    c.header("Cache-Control", "no-store");
    return c.body(Readable.toWeb(createReadStream(runnerPackage.path)) as ReadableStream);
  };

type AppOptions = {
  port: () => number;
  // The built portal: a path outside the API that is no file gets its `index.html`.
  portalFolder?: string;
  // undefined on this machine, where each request acts as an Admin.
  auth: Auth | undefined;
  trustedProxy?: string;
  runnerPackage?: RunnerPackage;
};

export const createApp = (services: Services, options: AppOptions) => {
  const { port, portalFolder, auth, trustedProxy, runnerPackage } = options;
  const app = new Hono();
  app.use("*", refuseFrames);
  // Before the checks of the API: the signature is the check of a delivery.
  app.post(
    "/api/github/webhook",
    bodyLimit({
      maxSize: maxDeliveryBytes,
      onError: (c) => c.json(errorBody("PAYLOAD_TOO_LARGE", "This delivery is too large"), 413),
    }),
    receiveGitHubDelivery(services),
  );
  if (auth) {
    app
      .use("/api/*", jsonWritesOnly)
      .use("/api/auth/*", addressRateLimit(trustedProxy))
      .use("/api/cli-logins/*", addressRateLimit(trustedProxy))
      .route("/api/auth", authRoutes(auth));
  } else {
    app.use("/api/*", localHostOnly(port), jsonWritesOnly);
  }
  // Its own limit: runners behind one address that update together must not block an enrollment.
  app.get("/api/runner/package", addressRateLimit(trustedProxy), serveRunnerPackage(runnerPackage));
  // A runner must not get the build of an earlier server from a cache.
  app.use("/api/runner/manifest", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });
  app.use("/api/runner/*", addressRateLimit(trustedProxy)).use("/api/*", async (c, next) => {
    const { matched, response } = await handler.handle(c.req.raw, {
      prefix: "/api",
      context: {
        services,
        origin: auth ? String(auth.options.baseURL) : new URL(c.req.url).origin,
        isLoginRequired: auth !== undefined,
        findUser: () => findApiUser(auth, services, c.req.raw.headers),
      },
    });
    if (matched) return c.newResponse(response.body, response);
    await next();
  });
  if (portalFolder) {
    app.get(
      "*",
      async (c, next) => (isApiPath(c.req.path) ? c.notFound() : next()),
      revalidateIndex,
      serveStatic({ root: portalFolder }),
      serveStatic({ root: portalFolder, path: "index.html" }),
    );
  }
  return app
    .notFound((c) =>
      c.json(errorBody("NOT_FOUND", `There is no ${c.req.method} ${c.req.path}`), 404),
    )
    .onError((error, c) => {
      console.error(error);
      return c.json(new ORPCError("INTERNAL_SERVER_ERROR").toJSON(), 500);
    });
};
