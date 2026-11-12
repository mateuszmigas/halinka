import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { type AddressInfo, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { Duplex } from "node:stream";

import type { ContainerProcesses } from "@halinka/sandbox/devcontainer";
import { tempFolder } from "@halinka/utils/testing";
import ssh2, { type Client as SshClient } from "ssh2";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { RunRelays } from "./runRelays";

const { Client, utils } = ssh2;
const { STATUS_CODE } = utils.sftp;

const defaultWorkflowRunId = 7;

const hostKey = utils.generateKeyPairSync("ed25519").private;

const publicKeyOf = (privateKey: string) => {
  const parsed = utils.parseKey(privateKey) as ssh2.ParsedKey;
  return parsed.getPublicSSH();
};

type Output = { stdout: string; stderr: string; code: number };

describe("RunRelays", () => {
  const setUp = async (isClaimed: () => boolean = () => false) => {
    const home = await tempFolder();
    const connected: number[] = [];
    const offeredKeys: Buffer[] = [];
    const started: ChildProcessWithoutNullStreams[] = [];
    const tracked = (child: ChildProcessWithoutNullStreams) => {
      started.push(child);
      onTestFinished(() => {
        child.kill();
      });
      return child;
    };
    const processes: ContainerProcesses = {
      run: (command, args = []) =>
        tracked(
          spawn("sh", ["-c", command, "sh", ...args], {
            cwd: home,
            env: { ...process.env, HOME: home },
          }),
        ),
      connect: (port) => {
        connected.push(port);
        return tracked(spawn("sh", ["-c", 'printf "from the bridge"; exec cat']));
      },
    };
    const relays = new RunRelays(hostKey, isClaimed);
    onTestFinished(() => relays.stopAll());
    // The ssh2 client needs a real socket: it reorders packets on a stream without a delay.
    const connect = async (workflowRunId = defaultWorkflowRunId) => {
      const listener = createServer();
      onTestFinished(() => {
        listener.close();
      });
      await once(listener.listen(0, "127.0.0.1"), "listening");
      const { port } = listener.address() as AddressInfo;
      const accepted = once(listener, "connection") as Promise<[Socket]>;
      const client: SshClient = new Client();
      client.on("error", () => {});
      onTestFinished(() => {
        client.end();
      });
      const ready = once(client, "ready");
      client.connect({
        host: "127.0.0.1",
        port,
        username: "any",
        hostVerifier: (key: Buffer) => {
          offeredKeys.push(key);
          return true;
        },
      });
      const [runner] = await accepted;
      relays.serve(workflowRunId, processes, runner);
      await ready;
      return { client, runner };
    };
    return { home, relays, processes, connect, connected, started, offeredKeys };
  };

  const exec = (client: SshClient, command: string, input?: string) =>
    new Promise<Output>((resolve, reject) => {
      client.exec(command, (error, channel) => {
        if (error) return reject(error);
        const output = { stdout: "", stderr: "", code: -1 };
        channel.on("data", (chunk: Buffer) => (output.stdout += chunk.toString()));
        channel.stderr.on("data", (chunk: Buffer) => (output.stderr += chunk.toString()));
        channel.on("exit", (code: number) => (output.code = code));
        channel.on("close", () => resolve(output));
        channel.end(input);
      });
    });

  const openSftp = (client: SshClient) =>
    new Promise<ssh2.SFTPWrapper>((resolve, reject) =>
      client.sftp((error, wrapper) => (error ? reject(error) : resolve(wrapper))),
    );

  it("offers the host key that it gets", async () => {
    const { connect, offeredKeys } = await setUp();

    await connect();

    expect(offeredKeys).toEqual([publicKeyOf(hostKey)]);
  });

  it("gives the output and the exit code of a command", async () => {
    const { connect } = await setUp();
    const { client } = await connect();

    const output = await exec(client, "echo out; echo err >&2; exit 3");

    expect(output).toEqual({ stdout: "out\n", stderr: "err\n", code: 3 });
  });

  it("gives a command its input", async () => {
    const { connect } = await setUp();
    const { client } = await connect();

    expect((await exec(client, "cat", "from the person")).stdout).toBe("from the person");
  });

  it("refuses a terminal", async () => {
    const { connect } = await setUp();
    const { client } = await connect();

    const refusal = await new Promise<Error | undefined>((resolve) =>
      client.shell({ term: "xterm" }, (error) => resolve(error)),
    );

    expect(refusal?.message).toBe("Unable to request a pseudo-terminal");
  });

  it("gives a shell without a terminal", async () => {
    const { connect } = await setUp();
    const { client } = await connect();

    const channel = await new Promise<ssh2.ClientChannel>((resolve, reject) =>
      client.shell(false, (error, stream) => (error ? reject(error) : resolve(stream))),
    );
    const answer = once(channel, "data");
    channel.write("echo from the shell\n");

    expect(String((await answer)[0])).toBe("from the shell\n");
  });

  it("connects a forward to the loopback of the container", async () => {
    const { connect, connected } = await setUp();
    const { client } = await connect();

    const channel = await new Promise<NodeJS.ReadWriteStream>((resolve, reject) =>
      client.forwardOut("127.0.0.1", 0, "127.0.0.1", 45_000, (error, stream) =>
        error ? reject(error) : resolve(stream),
      ),
    );

    expect(String((await once(channel, "data"))[0])).toBe("from the bridge");
    expect(connected).toEqual([45_000]);
  });

  it("refuses a forward to another host", async () => {
    const { connect, connected } = await setUp();
    const { client } = await connect();

    const refusal = await new Promise<Error | undefined>((resolve) =>
      client.forwardOut("127.0.0.1", 0, "172.17.0.1", 80, (error) => resolve(error)),
    );

    expect(refusal).toBeDefined();
    expect(connected).toEqual([]);
  });

  it("refuses a forward from the container", async () => {
    const { connect } = await setUp();
    const { client } = await connect();

    const refusal = await new Promise<Error | undefined>((resolve) =>
      client.forwardIn("127.0.0.1", 8080, (error) => resolve(error)),
    );

    expect(refusal).toBeDefined();
  });

  it("copies a file like scp, into the home folder", async () => {
    const { connect, home } = await setUp();
    const { client } = await connect();
    const sftp = await openSftp(client);

    await new Promise<void>((resolve, reject) => {
      const stream = sftp.createWriteStream("copied.bin");
      stream.on("close", resolve).on("error", reject);
      stream.end(Buffer.alloc(100_000, "a"));
    });

    expect(await readFile(join(home, "copied.bin"))).toEqual(Buffer.alloc(100_000, "a"));
  });

  it("gives an exit status at the end of a copy, as scp requires", async () => {
    const { connect } = await setUp();
    const { client } = await connect();
    const channel = await new Promise<ssh2.ClientChannel>((resolve, reject) =>
      client.subsys("sftp", (error, stream) => (error ? reject(error) : resolve(stream))),
    );
    const exit = once(channel, "exit");

    channel.end();

    expect((await exit)[0]).toBe(0);
  });

  it("gives the home folder for a relative path", async () => {
    const { connect, home } = await setUp();
    const { client } = await connect();
    const sftp = await openSftp(client);

    const path = await new Promise<string>((resolve, reject) =>
      sftp.realpath(".", (error, resolved) => (error ? reject(error) : resolve(resolved))),
    );

    expect(path).toBe(home);
  });

  it("gives the path of a file that does not exist yet", async () => {
    const { connect, home } = await setUp();
    const { client } = await connect();
    const sftp = await openSftp(client);

    const path = await new Promise<string>((resolve, reject) =>
      sftp.realpath("new.bin", (error, resolved) => (error ? reject(error) : resolve(resolved))),
    );

    expect(path).toBe(join(home, "new.bin"));
  });

  it("gives the size of a file", async () => {
    const { connect, home } = await setUp();
    await writeFile(join(home, "file.txt"), "12345");
    const { client } = await connect();
    const sftp = await openSftp(client);

    const stats = await new Promise<ssh2.Stats>((resolve, reject) =>
      sftp.stat("file.txt", (error, found) => (error ? reject(error) : resolve(found))),
    );

    expect(stats.size).toBe(5);
    expect(stats.isFile()).toBe(true);
  });

  it("tells that a path is a folder", async () => {
    const { connect, home } = await setUp();
    await mkdir(join(home, "folder"));
    const { client } = await connect();
    const sftp = await openSftp(client);

    const stats = await new Promise<ssh2.Stats>((resolve, reject) =>
      sftp.stat("folder", (error, found) => (error ? reject(error) : resolve(found))),
    );

    expect(stats.isDirectory()).toBe(true);
  });

  it("refuses the stat of a path that does not exist", async () => {
    const { connect } = await setUp();
    const { client } = await connect();
    const sftp = await openSftp(client);

    const refusal = await new Promise<Error | undefined>((resolve) =>
      sftp.stat("missing", (error) => resolve(error)),
    );

    expect(refusal).toMatchObject({ code: STATUS_CODE.NO_SUCH_FILE });
  });

  it("refuses a write at another offset", async () => {
    const { connect } = await setUp();
    const { client } = await connect();
    const sftp = await openSftp(client);
    const handle = await new Promise<Buffer>((resolve, reject) =>
      sftp.open("copied.bin", "w", (error, opened) => (error ? reject(error) : resolve(opened))),
    );

    const refusal = await new Promise<Error | null | undefined>((resolve) =>
      sftp.write(handle, Buffer.from("a"), 0, 1, 100, (error) => resolve(error)),
    );

    expect(refusal).toMatchObject({ code: STATUS_CODE.FAILURE });
  });

  it("fails the close of a file whose write ended before the close", async () => {
    const { connect, started } = await setUp();
    const { client } = await connect();
    const sftp = await openSftp(client);
    const handle = await new Promise<Buffer>((resolve, reject) =>
      sftp.open("no-folder/copied.bin", "w", (error, opened) =>
        error ? reject(error) : resolve(opened),
      ),
    );
    await vi.waitFor(() => expect(started[0]?.exitCode).not.toBeNull());

    const refusal = await new Promise<Error | null | undefined>((resolve) =>
      sftp.close(handle, (error) => resolve(error)),
    );

    expect(refusal).toMatchObject({ code: STATUS_CODE.FAILURE });
  });

  it("fails a path with a NUL", async () => {
    const { connect } = await setUp();
    const { client } = await connect();
    const sftp = await openSftp(client);

    const refusal = await new Promise<Error | undefined>((resolve) =>
      sftp.stat("a\0b", (error) => resolve(error)),
    );

    expect(refusal).toMatchObject({ code: STATUS_CODE.FAILURE });
  });

  it("fails a copy above the limit of processes", async () => {
    const { connect, started } = await setUp();
    const { client } = await connect();
    const sftp = await openSftp(client);
    for (let open = 0; open < 64; open++) void exec(client, "exec sleep 60").catch(() => {});
    await vi.waitFor(() => expect(started).toHaveLength(64), { timeout: 10_000 });

    const refusal = await new Promise<Error | undefined>((resolve) =>
      sftp.stat("file.txt", (error) => resolve(error)),
    );

    expect(refusal).toMatchObject({ code: STATUS_CODE.FAILURE });
    expect(started).toHaveLength(64);
  });

  it("refuses to read a file that exists", async () => {
    const { connect, home } = await setUp();
    await writeFile(join(home, "secret.txt"), "secret");
    const { client } = await connect();
    const sftp = await openSftp(client);

    const refusal = await new Promise<Error | null | undefined>((resolve) =>
      sftp.open("secret.txt", "r", (error) => resolve(error)),
    );

    expect(refusal).toMatchObject({ code: STATUS_CODE.OP_UNSUPPORTED });
  });

  it("refuses to remove a file", async () => {
    const { connect, home } = await setUp();
    await writeFile(join(home, "kept.txt"), "kept");
    const { client } = await connect();
    const sftp = await openSftp(client);

    const refusal = await new Promise<Error | null | undefined>((resolve) =>
      sftp.unlink("kept.txt", (error) => resolve(error)),
    );

    expect(refusal).toMatchObject({ code: STATUS_CODE.OP_UNSUPPORTED });
    expect(await readFile(join(home, "kept.txt"), "utf8")).toBe("kept");
  });

  it("does not serve a run that this runner holds", async () => {
    const { relays, processes } = await setUp(() => true);
    const runner = new Duplex({ read() {} });

    expect(() => relays.serve(defaultWorkflowRunId, processes, runner)).toThrow(
      `Run ${defaultWorkflowRunId} is active`,
    );
    expect(runner.destroyed).toBe(true);
  });

  it("ends the sessions of a run", async () => {
    const { relays, connect } = await setUp();
    const { client, runner } = await connect();
    const clientClosed = once(client, "close");

    relays.stopRun(defaultWorkflowRunId);

    await clientClosed;
    expect(runner.destroyed).toBe(true);
  });

  it("keeps the sessions of another run", async () => {
    const { relays, connect } = await setUp();
    const { client } = await connect(defaultWorkflowRunId + 1);

    relays.stopRun(defaultWorkflowRunId);

    expect((await exec(client, "echo open")).stdout).toBe("open\n");
  });

  it("refuses a command above the limit of processes", async () => {
    const { connect, started } = await setUp();
    const { client } = await connect();
    for (let open = 0; open < 64; open++) void exec(client, "exec sleep 60").catch(() => {});
    await vi.waitFor(() => expect(started).toHaveLength(64), { timeout: 10_000 });

    await expect(exec(client, "echo above")).rejects.toThrow("Unable to exec");
  });

  it("stops the processes of a session at its end", async () => {
    const { relays, connect, started } = await setUp();
    const { client } = await connect();
    void exec(client, "exec sleep 60").catch(() => {});
    await vi.waitFor(() => expect(started).toHaveLength(1));
    const stopped = once(started[0]!, "close");

    relays.stopRun(defaultWorkflowRunId);

    await stopped;
  });

  it("ends a session when its stream closes", async () => {
    const { connect, started } = await setUp();
    const { client, runner } = await connect();
    void exec(client, "exec sleep 60").catch(() => {});
    await vi.waitFor(() => expect(started).toHaveLength(1));
    const stopped = once(started[0]!, "close");

    runner.destroy();

    await stopped;
  });
});
