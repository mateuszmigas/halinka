import type { Duplex } from "node:stream";

import type { ControlPlane } from "./controlPlane";
import type { ProtocolError } from "./errors";
import type { RunnerCommands } from "./runnerCommands";

// Calls in both directions carry plain JSON data; an error keeps its `code` across the transport.

// The first message of a runner process.
export type RunnerHello = { instanceId: string };

// The view of the server of one connection.
export type RunnerSession = RunnerHello & {
  publicKey: string;
  commands: RunnerCommands;
  // ends the connection for good
  close: (reason: string) => void;
};

export type RelayHello = RunnerHello & { relayId: string; publicKey: string };

export type StreamSocket = {
  headers: Record<string, string | string[] | undefined>;
  stream: Duplex;
  close: (reason: string) => void;
};

export type RunnerAcceptor = {
  // refuses with `refused`; calls `ended` once; `serverId` is 12 hex: a runner puts it in paths
  acceptRunner: (
    session: RunnerSession,
  ) => Promise<{ plane: ControlPlane; ended: () => void; serverId: string }>;
  // undefined refuses; the stream comes after the runner gets the accept
  acceptRelay: (hello: RelayHello) => ((stream: Duplex) => void) | undefined;
};

// The view of the runner: the transport owns the reconnects.
export type RunnerConnection = {
  // the same object across reconnects
  plane: ControlPlane;
  // another `serverId` at a reconnect ends the connection
  serverId: string;
  // the refusal of the server, or undefined after `close`
  closed: Promise<ProtocolError | undefined>;
  close: () => void;
  openRelay: (relayId: string) => Promise<Duplex>;
};

// Each error but `refused` gives another attempt, also at a reconnect, until `signal` aborts.
export type ConnectOptions = {
  signal?: AbortSignal;
  onFailedAttempt?: (error: Error) => void;
};

export type RunnerTransport = {
  connect: (
    hello: RunnerHello,
    commands: RunnerCommands,
    options?: ConnectOptions,
  ) => Promise<RunnerConnection>;
};
