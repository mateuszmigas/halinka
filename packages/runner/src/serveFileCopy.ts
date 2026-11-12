import type { ChildProcessWithoutNullStreams } from "node:child_process";

import ssh2, { type SFTPWrapper } from "ssh2";

const { OPEN_MODE, STATUS_CODE } = ssh2.utils.sftp;

const folderMode = 0o040755;
const fileMode = 0o100644;

const resolvedPath =
  'cd; case "$1" in /*) p=$1;; *) p=$PWD/$1;; esac; cd -- "$p" 2>/dev/null && pwd || printf "%s\\n" "$p"';
const pathKind =
  'cd; if [ -d "$1" ]; then echo directory; elif [ -e "$1" ]; then wc -c <"$1"; else exit 1; fi';
const writeFile = 'cd; exec cat >"$1"';

type Run = (command: string, args: string[]) => ChildProcessWithoutNullStreams;

// ssh2 has no method for this on an SFTP channel, and `scp` fails without an exit status.
const sendExitStatus = (sftp: SFTPWrapper) => {
  const { _protocol, outgoing } = sftp as unknown as {
    _protocol: { exitStatus: (channel: number, status: number) => void };
    outgoing: { id: number };
  };
  _protocol.exitStatus(outgoing.id, 0);
};

// From the start of the child: it can end before the code asks.
const waitForExit = (child: ChildProcessWithoutNullStreams) =>
  new Promise<number | null>((resolve) => child.once("close", resolve));

const readOutput = async (child: ChildProcessWithoutNullStreams) => {
  const exit = waitForExit(child);
  let text = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
  child.stdin.end();
  return (await exit) === 0 ? text.trim() : undefined;
};

const attributesOf = (mode: number, size: number) => ({
  mode,
  size,
  uid: 0,
  gid: 0,
  atime: 0,
  mtime: 0,
});

// An image has no `sftp-server`, and Remote-SSH needs `scp` of a file without internet.
export const serveFileCopy = (sftp: SFTPWrapper, run: Run) => {
  const files = new Map<
    string,
    { child: ChildProcessWithoutNullStreams; exit: Promise<number | null>; written: number }
  >();
  let nextHandle = 0;
  const fail = (id: number) => sftp.status(id, STATUS_CODE.FAILURE);
  // A path with a NUL makes `spawn` throw, and the session can be at its limit of processes.
  const answering = (id: number, work: () => unknown) => {
    void (async () => work())().catch(() => fail(id));
  };
  sftp.on("end", () => {
    sendExitStatus(sftp);
    sftp.end();
  });
  const realPath = async (id: number, path: string) => {
    const filename = await readOutput(run(resolvedPath, [path]));
    if (filename === undefined) return fail(id);
    sftp.name(id, [{ filename, longname: filename, attrs: attributesOf(folderMode, 0) }]);
  };
  sftp.on("REALPATH", (id, path) => answering(id, () => realPath(id, path)));
  const stat = async (id: number, path: string) => {
    const kind = await readOutput(run(pathKind, [path]));
    if (kind === undefined) return sftp.status(id, STATUS_CODE.NO_SUCH_FILE);
    sftp.attrs(
      id,
      kind === "directory" ? attributesOf(folderMode, 0) : attributesOf(fileMode, Number(kind)),
    );
  };
  sftp.on("STAT", (id, path) => answering(id, () => stat(id, path)));
  sftp.on("LSTAT", (id, path) => answering(id, () => stat(id, path)));
  sftp.on("OPEN", (id, path, flags) => {
    if (!(flags & OPEN_MODE.WRITE)) return sftp.status(id, STATUS_CODE.OP_UNSUPPORTED);
    answering(id, () => {
      const child = run(writeFile, [path]);
      const handle = Buffer.alloc(4);
      handle.writeUInt32BE(nextHandle++);
      files.set(handle.toString("hex"), { child, exit: waitForExit(child), written: 0 });
      sftp.handle(id, handle);
    });
  });
  sftp.on("WRITE", (id, handle, offset, data) => {
    const file = files.get(handle.toString("hex"));
    if (!file || offset !== file.written) return fail(id);
    file.written += data.length;
    file.child.stdin.write(data, (error) =>
      sftp.status(id, error ? STATUS_CODE.FAILURE : STATUS_CODE.OK),
    );
  });
  sftp.on("FSTAT", (id, handle) => {
    const file = files.get(handle.toString("hex"));
    if (!file) return fail(id);
    sftp.attrs(id, attributesOf(fileMode, file.written));
  });
  const accept = (id: number) => sftp.status(id, STATUS_CODE.OK);
  // ssh2 refuses an operation that has no listener.
  sftp.on("FSETSTAT", accept);
  sftp.on("SETSTAT", accept);
  const close = async (id: number, handle: Buffer) => {
    const key = handle.toString("hex");
    const file = files.get(key);
    if (!file) return fail(id);
    files.delete(key);
    file.child.stdin.end();
    sftp.status(id, (await file.exit) === 0 ? STATUS_CODE.OK : STATUS_CODE.FAILURE);
  };
  sftp.on("CLOSE", (id, handle) => answering(id, () => close(id, handle)));
};
