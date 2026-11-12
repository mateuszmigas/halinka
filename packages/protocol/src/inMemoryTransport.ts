import { duplexPair } from "node:stream";

import { controlPlaneMethods } from "./checkedPlane";
import { connectionClosed, type ProtocolError, refused } from "./errors";
import { wrapMethods } from "./methods";
import { type RunnerCommands, runnerCommandMethods } from "./runnerCommands";
import type {
  ConnectOptions,
  RunnerAcceptor,
  RunnerConnection,
  RunnerHello,
  RunnerTransport,
} from "./transport";

const copied = <T>(value: T): T =>
  value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);

// As over the network: the values cross as JSON, and calls fail once the connection is closed.
const connected = <T extends object>(
  target: T,
  methods: readonly (keyof T & string)[],
  isOpen: () => boolean,
) =>
  wrapMethods(target, methods, (method) => async (...args) => {
    if (!isOpen()) throw connectionClosed();
    return copied(await method(...copied(args)));
  });

// The runner and the server are in one process, so the runner's key needs no signature.
export class InMemoryTransport implements RunnerTransport {
  constructor(
    private readonly server: RunnerAcceptor,
    private readonly publicKey: string,
  ) {}

  async connect(
    hello: RunnerHello,
    commands: RunnerCommands,
    { signal }: ConnectOptions = {},
  ): Promise<RunnerConnection> {
    signal?.throwIfAborted();
    let open = true;
    const isOpen = () => open;
    const closed = Promise.withResolvers<ProtocolError | undefined>();
    let ended = () => {};
    const end = (reason?: string) => {
      if (!open) return;
      open = false;
      ended();
      closed.resolve(reason === undefined ? undefined : refused(reason));
    };
    const accepted = await this.server.acceptRunner({
      ...hello,
      publicKey: this.publicKey,
      commands: connected(commands, runnerCommandMethods, isOpen),
      close: end,
    });
    ended = accepted.ended;
    if (!open) accepted.ended();
    if (signal?.aborted) end();
    signal?.throwIfAborted();
    return {
      plane: connected(accepted.plane, controlPlaneMethods, isOpen),
      serverId: accepted.serverId,
      closed: closed.promise,
      close: () => end(),
      openRelay: async (relayId) => {
        const attach = this.server.acceptRelay({
          ...hello,
          relayId,
          publicKey: this.publicKey,
        });
        if (!attach) throw refused("The server does not wait for this relay");
        const [runnerSide, serverSide] = duplexPair();
        attach(serverSide);
        return runnerSide;
      },
    };
  }
}
