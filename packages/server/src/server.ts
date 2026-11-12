import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  type Build,
  checkedPlane,
  type RelayHello,
  refused,
  type RunnerAcceptor,
  type RunnerCommands,
  type RunnerSession,
} from "@halinka/protocol";
import { WebSocketServerTransport } from "@halinka/protocol/webSocket";
import { serve } from "@hono/node-server";

import { createApp } from "./api/app";
import { createAuth, findApiUser } from "./auth/auth";
import { type AuthConfig, isLocalHostname } from "./auth/config";
import { ServerControlPlane } from "./controlPlane";
import { type Db, type DbLocation, openDb } from "./db/client";
import {
  createRepositories,
  inTransaction,
  type RunnerIdentity,
  type ServerBuild,
} from "./db/repositories";
import { defaultLeaseTimes, type LeaseTimes } from "./leaseTimes";
import { classifiedPlane } from "./planeErrors";
import { RateLimiter } from "./rateLimiter";
import { Relays } from "./relays";
import { RunBus } from "./runBus";
import { keyRefusalReason, keyRetiredReason, noAuthorityReason } from "./runnerAccess";
import { readRunnerPackage } from "./runnerPackage";
import { workflowRunIdOfSshPath } from "./runSshPath";
import { SecretCipher } from "./secrets";
import { createServices, type Services } from "./services";
import { sweep } from "./sweep";

const localHostname = "127.0.0.1";

const isWildcard = (host: string) => host === "0.0.0.0" || host === "::";

type ServerOptions = {
  port: number;
  build: Build;
  // the packed package of this build; a runner installs it
  runnerPackageFile?: string;
  dbLocation: DbLocation;
  masterKey: Buffer;
  portalFolder?: string;
  leaseTimes?: LeaseTimes;
  auth?: AuthConfig;
  host?: string;
};

type Running = {
  db: Db;
  bus: RunBus;
  services: Services;
  serverId: string;
  serverBuild: ServerBuild;
  relays: Relays;
  http: HttpServer;
  port: number;
  close: () => Promise<void>;
};

type Session = {
  runnerId: number;
  instanceId: string;
  publicKey: string;
  commands: RunnerCommands;
  close: (reason: string) => void;
};

// The HTTP API and the runner connections share the server's state.
export class Server implements RunnerAcceptor {
  private running: Running | undefined;
  // Map order: the newest session is last.
  private readonly sessions = new Map<string, Session>();

  private readonly leaseTimes: LeaseTimes;

  private localRunnerId: number | undefined;

  private readonly cipher: SecretCipher;

  constructor(private readonly options: ServerOptions) {
    this.leaseTimes = options.leaseTimes ?? defaultLeaseTimes;
    this.cipher = new SecretCipher(options.masterKey);
  }

  get port() {
    return this.started().port;
  }

  get url() {
    const { host = localHostname } = this.options;
    const authority = isWildcard(host) ? localHostname : host.includes(":") ? `[${host}]` : host;
    return `http://${authority}:${this.port}`;
  }

  // What a person opens.
  get publicUrl() {
    return this.options.auth?.publicUrl ?? this.url;
  }

  get http() {
    return this.started().http;
  }

  async start() {
    const { host = localHostname, auth } = this.options;
    if (!auth && !isLocalHostname(host)) {
      throw new Error(`The server listens on ${host} only with a login. Set the login values.`);
    }
    const { runnerPackageFile } = this.options;
    const readingPackage = runnerPackageFile ? readRunnerPackage(runnerPackageFile) : undefined;
    // Its error comes at the await below; until then, it must not be an unhandled rejection.
    readingPackage?.catch(() => {});
    const { db, close: closeDb } = await openDb(this.options.dbLocation);
    const repositories = createRepositories(db);
    await repositories.workflowRun.extendLeases(this.leaseTimes.leaseSeconds);
    const serverId = await repositories.serverIdentity.findOrCreate();
    const bus = new RunBus();
    const connectedRunners = {
      commandsOf: (id: number) => this.sessionsOf(id).map(({ commands }) => commands),
      listIds: () => [...new Set([...this.sessions.values()].map(({ runnerId }) => runnerId))],
      close: (id: number, reason: string) => {
        for (const session of this.sessionsOf(id)) session.close(reason);
      },
    };
    const runnerPackage = await readingPackage;
    const services = createServices({
      db,
      build: this.options.build,
      ...(runnerPackage && { runnerPackage }),
      ...(auth && { publicUrl: auth.publicUrl }),
      connectedRunners,
      bus,
      localRunnerId: () => this.localRunnerId,
      cipher: this.cipher,
    });
    const betterAuth = auth && createAuth(db, services.member, auth);
    const app = createApp(services, {
      port: () => this.port,
      portalFolder: this.options.portalFolder,
      ...(runnerPackage && { runnerPackage }),
      auth: betterAuth,
      ...(auth?.trustedProxy && { trustedProxy: auth.trustedProxy }),
    });
    const listening = Promise.withResolvers<AddressInfo>();
    const http = serve(
      { fetch: app.fetch, port: this.options.port, hostname: host },
      listening.resolve,
    ) as HttpServer;
    http.once("error", listening.reject);
    const connectionLimiter = new RateLimiter(auth?.trustedProxy);
    const relays = new Relays({
      findUser: (headers) => findApiUser(betterAuth, services, headers),
      runs: services.run,
      bus,
      sessionOf: (runnerId) => this.sessionsOf(runnerId).at(-1),
    });
    const runnerSockets = new WebSocketServerTransport(http, this, {
      ...(auth && { publicUrl: auth.publicUrl }),
      streamSocketOf: (path) => {
        const workflowRunId = workflowRunIdOfSshPath(path);
        return workflowRunId === undefined
          ? undefined
          : (socket) => {
              relays.open(workflowRunId, socket).catch((error: unknown) => {
                console.error(error);
                socket.close("The server could not open the session");
              });
            };
      },
      allowsConnection: ({ socket, headers }) =>
        connectionLimiter.take(
          socket.remoteAddress ?? "",
          headers["x-forwarded-for"] as string | undefined,
        ).isAllowed,
    });
    runnerSockets.listen();
    const { port } = await listening.promise;
    let sweeping: Promise<void> | undefined;
    const sweepOnce = () => {
      sweeping ??= sweep(db, bus, this.leaseTimes.leaseSeconds).finally(
        () => (sweeping = undefined),
      );
    };
    // Apart from the sweep: a slow read from GitHub must not hold the release of expired runs.
    let firing: Promise<void> | undefined;
    const fireSchedules = () => {
      firing ??= services.schedule
        .fireDue()
        .catch((error: unknown) => console.error(error))
        .finally(() => (firing = undefined));
    };
    const tick = () => {
      sweepOnce();
      fireSchedules();
    };
    tick();
    const sweeper = setInterval(tick, this.leaseTimes.sweepMs);
    this.running = {
      db,
      bus,
      services,
      serverId,
      serverBuild: { buildId: this.options.build.id, hasPackage: runnerPackage !== undefined },
      relays,
      http,
      port,
      close: async () => {
        clearInterval(sweeper);
        await Promise.all([sweeping, firing]);
        relays.close();
        runnerSockets.close();
        // `close` waits for open connections, and a run stream stays open until its client leaves.
        http.closeAllConnections();
        await http[Symbol.asyncDispose]();
        await bus.idle();
        await services.gitHubDelivery.idle();
        await closeDb();
      },
    };
  }

  async acceptRunner({ instanceId, publicKey, commands, close }: RunnerSession) {
    const { db, bus, services, serverId, serverBuild } = this.started();
    const repositories = createRepositories(db);
    const runner = await repositories.runner.findByPublicKey(publicKey);
    if (!runner) throw refused("The server does not know the key of this runner");
    const reason = keyRefusalReason(runner);
    if (reason) throw refused(reason);
    const { id: runnerId } = runner;
    const promoted =
      runner.keyState === "pending" &&
      (await inTransaction(db, async ({ runner, runnerKey }) => {
        await runner.lockById(runnerId);
        return runnerKey.promote(runnerId, publicKey);
      }));
    if (promoted) {
      for (const other of this.sessionsOf(runnerId)) {
        if (other.publicKey !== publicKey) other.close(keyRetiredReason);
      }
    }
    const key = `${runnerId}:${instanceId}`;
    const session = { runnerId, instanceId, publicKey, commands, close };
    this.sessions.get(key)?.close("A new connection of this runner process replaced this one");
    // Delete first to move the session to the end.
    this.sessions.delete(key);
    this.sessions.set(key, session);
    const ended = () => {
      this.running?.relays.endSession(session);
      if (this.sessions.get(key) !== session) return;
      this.sessions.delete(key);
      this.notifyQueuedRuns(runnerId);
    };
    // A revoke or a new key that committed during the lookup did not close this session.
    if (!(await repositories.runner.hasAuthority(runnerId, publicKey))) {
      ended();
      throw refused(noAuthorityReason);
    }
    this.notifyQueuedRuns(runnerId);
    const plane = new ServerControlPlane(
      { runnerId, instanceId, publicKey },
      {
        db,
        serverBuild,
        bus,
        leaseSeconds: this.leaseTimes.leaseSeconds,
        cipher: this.cipher,
        gitHubApp: services.gitHubApp,
      },
    );
    return { plane: checkedPlane(classifiedPlane(plane)), ended, serverId };
  }

  acceptRelay(hello: RelayHello) {
    return this.started().relays.accept(hello);
  }

  // Undefined when another runner has the name. `refusal`: why the hello of the key fails.
  async registerLocalRunner({ name, publicKey }: RunnerIdentity) {
    const registered = await inTransaction(this.started().db, async ({ runner, runnerKey }) => {
      const known = await runner.findByPublicKey(publicKey);
      if (known) return { ...known, refusal: keyRefusalReason(known) };
      const local = await runner.create({ name });
      if (!local) return undefined;
      await runnerKey.create(local.id, publicKey, "current");
      return { ...local, refusal: undefined };
    });
    if (registered && !registered.refusal) this.localRunnerId = registered.id;
    return registered;
  }

  async stop() {
    const { running } = this;
    this.running = undefined;
    await running?.close();
  }

  // A stopping server starts no more.
  private notifyQueuedRuns(runnerId: number) {
    if (!this.running) return;
    const { db, bus } = this.running;
    void bus.notifyQueuedRuns(createRepositories(db), runnerId);
  }

  private sessionsOf(runnerId: number) {
    return [...this.sessions.values()].filter((session) => session.runnerId === runnerId);
  }

  private started() {
    if (!this.running) throw new Error("The server is not started");
    return this.running;
  }
}
