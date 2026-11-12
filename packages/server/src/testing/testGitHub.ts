import { createHmac, generateKeyPairSync } from "node:crypto";

import { vi } from "vitest";

import type { Db } from "../db/client";
import { gitHubDeliveries } from "../db/schema";
import { octo } from "./testAuth";
import { type createTestServer, testApiUrl } from "./testServer";

export const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

export const repoOf = (id: number, name: string, owner = "acme") => ({
  id,
  name,
  owner: { login: owner },
});

type FakeRepo = ReturnType<typeof repoOf>;

type FakeInstallation = {
  id: number;
  account: { login: string };
  suspended_at: string | null;
  repos: FakeRepo[];
};

type InstallationOptions = { isSuspended?: boolean };

type TreeOptions = { isRecursive: boolean };

export const installationOf = (
  id: number,
  repos: FakeRepo[],
  { isSuspended = false }: InstallationOptions = {},
): FakeInstallation => ({
  id,
  account: { login: "acme" },
  suspended_at: isSuspended ? "2026-11-01T00:00:00Z" : null,
  repos,
});

const shaOf = (path: string) => Buffer.from(path).toString("hex");

const pathOf = (sha: string) => Buffer.from(sha, "hex").toString();

const pageOf = <T>(items: T[], url: URL) => {
  const size = Number(url.searchParams.get("per_page"));
  const page = Number(url.searchParams.get("page"));
  return items.slice((page - 1) * size, page * size);
};

type AnswerWriteOptions = { method: string; body: Record<string, unknown> };

export class FakeGitHub {
  readonly requests: { url: URL; method: string; authorization: string | null; body: unknown }[] =
    [];
  readonly branches = new Map<string, string>();
  readonly pulls: { head: string; state: "open" | "closed"; url: string; body: object }[] = [];
  // true: GitHub answers 422 to a POST of this path
  refuseWrite: ((pathname: string) => boolean) | undefined;
  owner: { id: number; login: string } = octo;
  webhookSecret: string | null = "hook-secret";
  installations: FakeInstallation[] = [];
  refuseWith: Response | undefined;
  duringConversion: (() => Promise<void>) | undefined;
  duringFirstRead: (() => Promise<void>) | undefined;
  repoFiles: Record<string, string> = {};
  fileModes: Record<string, string> = {};
  defaultBranch = "main";
  head = "c".repeat(40);
  isTruncated = false;

  readonly fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const authorization = new Headers(init.headers).get("authorization");
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    const method = init.method ?? "GET";
    this.requests.push({ url, method, authorization, body });
    if (this.refuseWith) return this.refuseWith;
    const { pathname } = url;
    if (pathname.startsWith("/app-manifests/")) {
      await this.duringConversion?.();
      return Response.json({
        id: 77,
        slug: "halinka-abc",
        html_url: "https://github.com/apps/halinka-abc",
        owner: this.owner,
        pem: privateKey,
        webhook_secret: this.webhookSecret,
        client_secret: "client-secret",
      });
    }
    if (pathname === "/app/installations") {
      const during = this.duringFirstRead;
      this.duringFirstRead = undefined;
      await during?.();
      return Response.json(pageOf(this.installations, url));
    }
    const tokenInstallationId = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(pathname)?.[1];
    if (tokenInstallationId) {
      const { repository_ids: ids } = body as { repository_ids?: number[] };
      const repos =
        this.installations.find((item) => item.id === Number(tokenInstallationId))?.repos ?? [];
      return Response.json({
        token: `token-${tokenInstallationId}`,
        repositories: repos.filter(({ id }) => ids?.includes(id)),
      });
    }
    if (pathname === "/installation/repositories") {
      const id = Number(authorization?.replace("Bearer token-", ""));
      const repos = this.installations.find((item) => item.id === id)?.repos ?? [];
      return Response.json({ repositories: pageOf(repos, url) });
    }
    return (
      this.answerWrite(url, { method, body: body as Record<string, unknown> }) ??
      this.answerContent(pathname, url)
    );
  };

  private answerWrite(url: URL, { method, body }: AnswerWriteOptions): Response | undefined {
    const { pathname } = url;
    const repo = "/repos/acme/app";
    if (method === "POST" && this.refuseWrite?.(pathname)) {
      return Response.json({ message: "Refused" }, { status: 422 });
    }
    if (pathname.startsWith(`${repo}/git/commits/`) && method === "GET") {
      return Response.json({ tree: { sha: "base-tree" } });
    }
    if (pathname === `${repo}/git/trees` && method === "POST") {
      return Response.json({ sha: "new-tree" });
    }
    if (pathname === `${repo}/git/commits` && method === "POST") {
      return Response.json({ sha: "new-commit" });
    }
    if (pathname === `${repo}/git/refs` && method === "POST") {
      this.branches.set(String(body.ref).replace("refs/heads/", ""), String(body.sha));
      return Response.json({ ref: body.ref, object: { type: "commit", sha: body.sha } });
    }
    const matching = pathname.split(`${repo}/git/matching-refs/heads/`)[1];
    if (matching) {
      const names = [...this.branches.keys()].filter((name) => name.startsWith(matching));
      return Response.json(names.map((name) => ({ ref: `refs/heads/${name}` })));
    }
    if (pathname === `${repo}/pulls` && method === "GET") {
      const head = url.searchParams.get("head");
      const open = this.pulls.filter(
        (pull) => pull.state === "open" && `acme:${pull.head}` === head,
      );
      return Response.json(open.map((pull) => ({ html_url: pull.url })));
    }
    if (pathname === `${repo}/pulls` && method === "POST") {
      const pull = {
        head: String(body.head),
        state: "open" as const,
        url: `https://github.com/acme/app/pull/${this.pulls.length + 1}`,
        body,
      };
      this.pulls.push(pull);
      return Response.json({ html_url: pull.url });
    }
    return undefined;
  }

  private answerContent(pathname: string, url: URL) {
    const repo = "/repos/acme/app";
    if (pathname === repo) return Response.json({ default_branch: this.defaultBranch });
    if (pathname === `${repo}/git/ref/heads/${this.defaultBranch}`) {
      return Response.json({ object: { sha: this.head } });
    }
    const treeSha = new RegExp(`^${repo}/git/trees/(.+)$`).exec(pathname)?.[1];
    if (treeSha) {
      const isRecursive = url.searchParams.get("recursive") === "1";
      return Response.json({
        tree: this.treeOf(treeSha, { isRecursive }),
        truncated: this.isTruncated,
      });
    }
    const blobSha = new RegExp(`^${repo}/git/blobs/(.+)$`).exec(pathname)?.[1];
    if (blobSha) {
      const source = this.repoFiles[pathOf(blobSha)] ?? "";
      return Response.json({
        content: Buffer.from(source).toString("base64"),
        encoding: "base64",
      });
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  }

  private treeOf(sha: string, { isRecursive }: TreeOptions) {
    const folder = sha === this.head ? "" : `${pathOf(sha)}/`;
    const entries = new Map<string, object>();
    for (const [path, source] of Object.entries(this.repoFiles)) {
      if (!path.startsWith(folder)) continue;
      const below = path.slice(folder.length);
      const [first = "", ...rest] = below.split("/");
      const isFolder = rest.length > 0 && !isRecursive;
      const name = isFolder ? first : below;
      entries.set(
        name,
        isFolder
          ? { path: name, mode: "040000", type: "tree", sha: shaOf(folder + name) }
          : {
              path: name,
              mode: this.fileModes[path] ?? "100644",
              type: "blob",
              sha: shaOf(path),
              size: Buffer.byteLength(source),
            },
      );
    }
    return [...entries.values()];
  }

  readsOf(pathname: string) {
    return this.requests.filter(({ url }) => url.pathname === pathname);
  }
}

export const defaultBody = '{ "action": "opened" }';

export const signatureOf = (body: string | Buffer, secret = "hook-secret") =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

export type Delivery = {
  id?: string;
  event?: string;
  body?: string | Buffer;
  signature?: string;
};

export const deliveryRequest = ({
  id = "delivery-1",
  event = "issues",
  body = defaultBody,
  signature = signatureOf(body),
}: Delivery = {}): Request =>
  new Request(`${testApiUrl}/api/github/webhook`, {
    method: "POST",
    headers: {
      ...(id && { "x-github-delivery": id }),
      ...(event && { "x-github-event": event }),
      ...(signature && { "x-hub-signature-256": signature }),
    },
    body,
  });

export const deliverEvent = async (
  { app, services }: Awaited<ReturnType<typeof createTestServer>>,
  db: Db,
  { id = "delivery-1", event, body }: { id?: string; event: string; body: object },
) => {
  await app.fetch(deliveryRequest({ id, event, body: JSON.stringify(body) }));
  await services.gitHubDelivery.idle();
  const rows = await db.select().from(gitHubDeliveries);
  return rows.find(({ deliveryId }) => deliveryId === id)?.result;
};

export const stateOf = ({ url }: { url: string }) => new URL(url).searchParams.get("state") ?? "";

type TestApi = Awaited<ReturnType<typeof createTestServer>>["api"];

// Connects the App, and stores what `installations` holds.
export const connectApp = async (
  api: TestApi,
  gitHub: FakeGitHub,
  installations: FakeInstallation[],
) => {
  vi.stubGlobal("fetch", gitHub.fetch);
  await api.github.connect({ code: "code", state: stateOf(await api.github.manifest({})) });
  gitHub.installations = installations;
  await api.github.refresh();
};
