import type { ChildProcess } from "node:child_process";

const stopSignals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

// The child gets each stop signal, and this process stays until the caller ends the forward.
export const forwardStopSignals = (child: ChildProcess) => {
  const forwards = stopSignals.map((signal) => [signal, () => child.kill(signal)] as const);
  for (const [signal, forward] of forwards) process.on(signal, forward);
  return () => {
    for (const [signal, forward] of forwards) process.off(signal, forward);
  };
};

// A later signal does not exit: detached worktree processes write the workspace until the stop ends.
export const stopOnSignals = (stop: () => Promise<void>) => {
  let stopping: Promise<void> | undefined;
  const onSignal = () => {
    if (stopping) console.error("halinka is stopping the runs. Wait for the stop to end.");
    stopping ??= stop()
      .catch((error: unknown) => console.error("halinka did not stop cleanly", error))
      .finally(() => {
        for (const signal of stopSignals) process.off(signal, onSignal);
      });
  };
  for (const signal of stopSignals) process.on(signal, onSignal);
};
