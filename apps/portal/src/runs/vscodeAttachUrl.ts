import type { ApiOutputs } from "@halinka/server/client";
import { sshHostOf } from "@halinka/utils/sshHost";

export type SandboxAttach = NonNullable<
  NonNullable<ApiOutputs["runs"]["get"]["sandbox"]>["attach"]
>;

const hexOf = (text: string) =>
  Array.from(new TextEncoder().encode(text), (byte) => byte.toString(16).padStart(2, "0")).join("");

const uriPathOf = (path: string) => path.split("/").map(encodeURIComponent).join("/");

export const vscodeAttachUrl = ({ containerName, containerFolder }: SandboxAttach) =>
  `vscode://vscode-remote/attached-container+${hexOf(JSON.stringify({ containerName: `/${containerName}` }))}${uriPathOf(containerFolder)}`;

export const vscodeSshUrl = (serverUrl: string, workflowRunId: number, folder: string) =>
  `vscode://vscode-remote/ssh-remote+${sshHostOf(serverUrl, workflowRunId)}${uriPathOf(folder)}`;
