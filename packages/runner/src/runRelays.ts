import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Duplex } from "node:stream";

import type { ContainerProcesses } from "@halinka/sandbox/devcontainer";
import ssh2, { type Connection, type ServerChannel } from "ssh2";

import { serveFileCopy } from "./serveFileCopy";

const { Server } = ssh2;

const maxProcesses = 64;

// The relay has no port: only a person that the server admits reaches this server.
const acceptNone = (client: Connection) =>
  client.on("authentication", (context) => {
    if (context.method === "none") context.accept();
    else context.reject(["none"]);
  });

// A forward reaches the loopback of the container, not the runner host.
const isContainerLoopback = (host: string) => host === "127.0.0.1" || host === "localhost";

class Relay {
  private readonly children = new Set<ChildProcessWithoutNullStreams>();
  private client: Connection | undefined;
  private isEnded = false;

  constructor(
    private readonly processes: ContainerProcesses,
    private readonly stream: Duplex,
    private readonly onEnd: () => void,
  ) {}

  serve(hostKey: string) {
    this.stream.on("close", () => this.end());
    new Server({ hostKeys: [hostKey] }, (client) => {
      this.client = client;
      client.on("error", () => {});
      client.on("close", () => this.end());
      acceptNone(client);
      client.on("ready", () => this.serveChannels(client));
    }).injectSocket(this.stream as never);
  }

  end() {
    if (this.isEnded) return;
    this.isEnded = true;
    for (const child of this.children) child.kill();
    this.client?.end();
    this.stream.destroy();
    this.onEnd();
  }

  // ssh2 refuses what has no listener: a terminal, a forward from the container.
  private serveChannels(client: Connection) {
    const runCommand = (
      accept: () => ServerChannel,
      reject: (() => void) | undefined,
      command: string,
    ) => {
      if (!this.canStart()) return reject?.();
      this.pipe(
        accept(),
        this.start(() => this.processes.run(command)),
      );
    };
    client.on("session", (acceptSession) => {
      const session = acceptSession();
      session.on("exec", (accept, reject, { command }) => runCommand(accept, reject, command));
      session.on("shell", (accept, reject) => runCommand(accept, reject, "exec sh"));
      session.on("sftp", (accept, reject) => {
        if (!this.canStart()) return reject?.();
        serveFileCopy(accept(), (command, args) =>
          this.start(() => this.processes.run(command, args)),
        );
      });
    });
    client.on("tcpip", (accept, reject, { destIP, destPort }) => {
      if (!this.canStart() || !isContainerLoopback(destIP)) return reject();
      this.bridge(
        accept(),
        this.start(() => this.processes.connect(destPort)),
      );
    });
  }

  private canStart() {
    return !this.isEnded && this.children.size < maxProcesses;
  }

  private start(spawnProcess: () => ChildProcessWithoutNullStreams) {
    if (!this.canStart()) throw new Error("The session cannot start another process");
    const child = spawnProcess();
    this.children.add(child);
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    child.on("close", () => this.children.delete(child));
    return child;
  }

  private pipe(channel: ServerChannel, child: ChildProcessWithoutNullStreams) {
    channel.pipe(child.stdin);
    child.stdout.pipe(channel, { end: false });
    child.stderr.pipe(channel.stderr, { end: false });
    channel.on("close", () => child.kill());
    child.on("close", (code) => {
      channel.exit(code ?? 255);
      channel.end();
    });
  }

  private bridge(channel: ServerChannel, child: ChildProcessWithoutNullStreams) {
    channel.pipe(child.stdin);
    child.stdout.pipe(channel);
    channel.on("close", () => child.kill());
    child.on("close", () => channel.end());
  }
}

export class RunRelays {
  private readonly relays = new Map<number, Set<Relay>>();

  constructor(
    private readonly hostKey: string,
    private readonly isClaimed: (workflowRunId: number) => boolean,
  ) {}

  // Without an `await`: a claim cannot come between the check and the registration.
  serve(workflowRunId: number, processes: ContainerProcesses, stream: Duplex) {
    if (this.isClaimed(workflowRunId)) {
      stream.destroy();
      throw new Error(`Run ${workflowRunId} is active on this runner`);
    }
    const relays = this.relays.get(workflowRunId) ?? new Set();
    const relay = new Relay(processes, stream, () => {
      relays.delete(relay);
      if (relays.size === 0) this.relays.delete(workflowRunId);
    });
    this.relays.set(workflowRunId, relays.add(relay));
    relay.serve(this.hostKey);
  }

  stopRun(workflowRunId: number) {
    for (const relay of this.relays.get(workflowRunId) ?? []) relay.end();
  }

  stopAll() {
    for (const workflowRunId of this.relays.keys()) this.stopRun(workflowRunId);
  }
}
