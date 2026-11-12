import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";

import type { RelayHello, RunnerCommands, StreamSocket } from "@halinka/protocol";
import { errorMessage } from "@halinka/utils/errors";
import { fromNodeHeaders } from "better-auth/node";

import type { ApiUser } from "./auth/auth";
import type { RunBus } from "./runBus";

const maxRelaysOfRun = 4;
const maxRelaysOfPerson = 8;
const accessCheckMs = 30_000;
const logInFirst = "Log in first: halinka login";

type RelaySession = {
  publicKey: string;
  instanceId: string;
  commands: Pick<RunnerCommands, "openRelay">;
};

type RelaysOptions = {
  findUser: (headers: Headers) => Promise<ApiUser | undefined>;
  runs: {
    openRelay: (workflowRunId: number) => Promise<number>;
    relayRefusal: (workflowRunId: number) => Promise<Error | undefined>;
  };
  bus: RunBus;
  sessionOf: (runnerId: number) => RelaySession | undefined;
};

type Relay = {
  id: string;
  workflowRunId: number;
  socket: StreamSocket;
  headers: Headers;
  login: string;
  runner?: Duplex;
  session?: RelaySession;
  unsubscribe: () => void;
};

export class Relays {
  private readonly relays = new Map<string, Relay>();
  private readonly checker = setInterval(() => {
    for (const relay of this.relays.values()) {
      void this.checkLogin(relay);
      void this.checkRun(relay);
    }
  }, accessCheckMs);

  constructor(private readonly options: RelaysOptions) {}

  async open(workflowRunId: number, socket: StreamSocket) {
    const headers = fromNodeHeaders(socket.headers);
    const user = await this.options.findUser(headers).catch(() => undefined);
    if (!user) return socket.close(logInFirst);
    // The stream gave its `close` before this listener exists.
    if (socket.stream.destroyed) return;
    const openOf = (matches: (relay: Relay) => boolean) =>
      [...this.relays.values()].filter(matches).length;
    if (openOf((relay) => relay.workflowRunId === workflowRunId) >= maxRelaysOfRun) {
      return socket.close(`Run ${workflowRunId} has too many open sessions`);
    }
    if (openOf((relay) => relay.login === user.login) >= maxRelaysOfPerson) {
      return socket.close("You have too many open sessions");
    }
    // Before the check of the run: a claim that commits after the check closes this relay.
    const relay: Relay = {
      id: randomUUID(),
      workflowRunId,
      socket,
      headers,
      login: user.login,
      unsubscribe: this.options.bus.subscribe(workflowRunId, (change) => {
        if (change === "state") void this.checkRun(relay);
      }),
    };
    this.relays.set(relay.id, relay);
    socket.stream.once("close", () => this.end(relay));
    try {
      const runnerId = await this.options.runs.openRelay(workflowRunId);
      const session = this.options.sessionOf(runnerId);
      if (!session) throw new Error("The runner is not connected");
      relay.session = session;
      await session.commands.openRelay({ relayId: relay.id, workflowRunId });
      if (this.relays.has(relay.id))
        console.log(`${user.login} opened the container of run ${workflowRunId}`);
    } catch (error) {
      this.end(relay, errorMessage(error));
    }
  }

  accept({ relayId, publicKey, instanceId }: RelayHello) {
    const relay = this.relays.get(relayId);
    const { session } = relay ?? {};
    if (
      !relay ||
      relay.runner ||
      session?.publicKey !== publicKey ||
      session.instanceId !== instanceId
    ) {
      return undefined;
    }
    return (stream: Duplex) => {
      relay.runner = stream;
      stream.once("close", () => this.end(relay, "The runner ended the session"));
      stream.pipe(relay.socket.stream, { end: false });
      relay.socket.stream.pipe(stream, { end: false });
    };
  }

  endSession(session: RelaySession) {
    for (const relay of this.relays.values()) {
      if (relay.session === session) this.end(relay, "The runner lost the connection");
    }
  }

  close() {
    clearInterval(this.checker);
    for (const relay of this.relays.values()) this.end(relay, "The server stops");
  }

  // A failure of the database keeps the relay until the next check.
  private async checkLogin(relay: Relay) {
    const isLoggedIn = await this.options.findUser(relay.headers).then(
      (user) => user !== undefined,
      () => true,
    );
    if (!isLoggedIn) this.end(relay, logInFirst);
  }

  private async checkRun(relay: Relay) {
    const refusal = await this.options.runs
      .relayRefusal(relay.workflowRunId)
      .catch(() => undefined);
    if (refusal) this.end(relay, errorMessage(refusal));
  }

  private end(relay: Relay, reason = "The session ended") {
    if (!this.relays.delete(relay.id)) return;
    relay.unsubscribe();
    relay.runner?.destroy();
    relay.socket.close(reason);
  }
}
