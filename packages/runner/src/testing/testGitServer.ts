import { spawn } from "node:child_process";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";

import { onTestFinished } from "vitest";

export const listenForTest = async (listener: RequestListener) => {
  const server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

export const gitHttpServer = async (root: string, authorization: string) => {
  const headers: (string | undefined)[] = [];
  const url = await listenForTest((request, response) => {
    headers.push(request.headers.authorization);
    if (request.headers.authorization !== authorization) {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' }).end();
      return;
    }
    const [path, query = ""] = (request.url ?? "").split("?");
    const backend = spawn("git", ["http-backend"], {
      stdio: ["pipe", "pipe", "ignore"],
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        REMOTE_USER: "x-access-token",
        PATH_INFO: path,
        QUERY_STRING: query,
        REQUEST_METHOD: request.method,
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        HTTP_CONTENT_ENCODING: request.headers["content-encoding"] ?? "",
      },
    });
    request.pipe(backend.stdin);
    const chunks: Buffer[] = [];
    backend.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    backend.on("close", () => {
      const output = Buffer.concat(chunks);
      const end = output.indexOf("\r\n\r\n");
      const lines = output.subarray(0, end).toString().split("\r\n");
      const { Status: status = "200", ...fields } = Object.fromEntries(
        lines.map((line) => line.split(": ", 2) as [string, string]),
      );
      response.writeHead(Number.parseInt(status, 10), fields).end(output.subarray(end + 4));
    });
  });
  return { url, headers };
};
