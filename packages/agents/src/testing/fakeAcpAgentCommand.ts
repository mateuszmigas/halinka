import { fileURLToPath } from "node:url";

export const fakeAcpAgentCommand = [
  process.execPath,
  fileURLToPath(new URL("./fakeAcpAgent.ts", import.meta.url)),
];
