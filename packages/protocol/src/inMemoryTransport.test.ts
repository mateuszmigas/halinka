import { once } from "node:events";
import type { Duplex } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type { ControlPlane, SyncRequest } from "./controlPlane";
import { InMemoryTransport } from "./inMemoryTransport";
import { testSyncRequest } from "./testing";
import type { RunnerSession } from "./transport";

const nothing = { keep: [], claimed: [], answers: [], messages: [], sandboxes: [] };

class StatefulPlane {
  readonly result = nothing;
  readonly requests: unknown[] = [];

  async sync(request: SyncRequest) {
    this.requests.push(request);
    return this.result;
  }

  async notListed() {}
}

const setUp = (accept: (session: RunnerSession) => void = () => {}) => {
  const relays = Promise.withResolvers<Duplex>();
  const sessions: RunnerSession[] = [];
  const ended = vi.fn();
  const statefulPlane = new StatefulPlane();
  const plane = statefulPlane as unknown as ControlPlane;
  const transport = new InMemoryTransport(
    {
      acceptRunner: async (session) => {
        accept(session);
        sessions.push(session);
        return { plane, ended, serverId: "0123456789ab" };
      },
      acceptRelay: ({ relayId }) => (relayId === "known" ? relays.resolve : undefined),
    },
    "runner-key",
  );
  const commands = {
    wake: async () => {},
    readRepo: async () => ({ realPath: "/code/app", head: "abc", files: {} }),
    writeRepoFile: async () => ({ hash: "" }),
    readCommitFile: async () => undefined,
    listFolders: async () => ({
      path: "/",
      isRepo: false,
      folders: [],
      isTruncated: false,
    }),
    listDevcontainers: async () => [],
    setUpRepo: async () => ({ files: [] }),
    pushBranch: async () => {},
    openPullRequest: async () => ({ url: "https://github.com/acme/app/pull/1", isCreated: true }),
    openRelay: async () => {},
    notListed: async () => {},
  };
  return {
    statefulPlane,
    sessions,
    ended,
    relays: relays.promise,
    connect: (signal?: AbortSignal) =>
      transport.connect({ instanceId: "runner-1" }, commands, { signal }),
  };
};

describe("InMemoryTransport", () => {
  it("carries the bytes of a relay to the server", async () => {
    const { connect, relays } = setUp();
    const connection = await connect();

    const runnerSide = await connection.openRelay("known");
    const atServer = once(await relays, "data");
    runnerSide.write("from the runner");

    expect(String((await atServer)[0])).toBe("from the runner");
  });

  it("refuses a relay that the server does not wait for", async () => {
    const { connect } = setUp();
    const connection = await connect();

    await expect(connection.openRelay("unknown")).rejects.toMatchObject({ code: "refused" });
  });

  it("does not call the server after an abort", async () => {
    const { sessions, connect } = setUp();

    await expect(connect(AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });

    expect(sessions).toEqual([]);
  });

  it("ends the session when the abort comes while the server accepts", async () => {
    const abort = new AbortController();
    const { ended, connect } = setUp(() => abort.abort());

    await expect(connect(abort.signal)).rejects.toMatchObject({ name: "AbortError" });

    expect(ended).toHaveBeenCalledOnce();
  });

  it("gives the runner the server's control plane", async () => {
    const connection = await setUp().connect();

    expect(await connection.plane.sync(testSyncRequest)).toEqual(nothing);
  });

  it("gives the server the arguments as JSON gives them", async () => {
    const { statefulPlane, connect } = setUp();
    const connection = await connect();

    await connection.plane.sync({ ...testSyncRequest, canTest: undefined });

    expect(statefulPlane.requests).toStrictEqual([testSyncRequest]);
  });

  it("gives the runner a copy of the answer", async () => {
    const { statefulPlane, connect } = setUp();
    const connection = await connect();

    const answer = await connection.plane.sync(testSyncRequest);

    expect(answer).not.toBe(statefulPlane.result);
  });

  it("gives the server the runner's hello and key", async () => {
    const { sessions, connect } = setUp();

    await connect();

    expect(sessions[0]).toMatchObject({ instanceId: "runner-1", publicKey: "runner-key" });
  });

  it("gives the runner only the control plane methods", async () => {
    const connection = await setUp().connect();

    expect("notListed" in connection.plane).toBe(false);
  });

  it("gives the server only the runner commands", async () => {
    const { sessions, connect } = setUp();

    await connect();

    expect(sessions[0] && "notListed" in sessions[0].commands).toBe(false);
  });

  it("fails the control plane calls after the runner closes the connection", async () => {
    const connection = await setUp().connect();

    connection.close();

    await expect(connection.plane.sync(testSyncRequest)).rejects.toMatchObject({
      code: "connection_closed",
    });
  });

  it("fails the server's calls to the runner after the connection closes", async () => {
    const { sessions, connect } = setUp();
    const connection = await connect();

    connection.close();

    await expect(sessions[0]?.commands.wake()).rejects.toMatchObject({
      code: "connection_closed",
    });
  });

  it("gives the runner the reason when the server closes the connection", async () => {
    const { sessions, connect } = setUp();
    const connection = await connect();

    sessions[0]?.close("Revoked");

    expect(await connection.closed).toMatchObject({ code: "refused", message: "Revoked" });
  });

  it("fails the control plane calls after the server closes the connection", async () => {
    const { sessions, connect } = setUp();
    const connection = await connect();

    sessions[0]?.close("Revoked");

    await expect(connection.plane.sync(testSyncRequest)).rejects.toMatchObject({
      code: "connection_closed",
    });
  });

  it("gives the runner no reason when the runner closes the connection", async () => {
    const connection = await setUp().connect();

    connection.close();

    expect(await connection.closed).toBeUndefined();
  });

  it("tells the server when the server closes the connection during the accept", async () => {
    const { ended, connect } = setUp((session) => session.close("Replaced"));

    await connect();

    expect(ended).toHaveBeenCalledOnce();
  });

  it("tells the server one time when the runner closes the connection twice", async () => {
    const { ended, connect } = setUp();
    const connection = await connect();

    connection.close();
    connection.close();

    expect(ended).toHaveBeenCalledOnce();
  });
});
