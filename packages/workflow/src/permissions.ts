import { z } from "zod";

const hostPattern =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

export const networkSchema = z.union([
  z.boolean(),
  z.array(
    z.string().regex(hostPattern, "Use a host name in lowercase, such as registry.npmjs.org"),
  ),
]);

export type Network = z.infer<typeof networkSchema>;

export type NetworkHosts = true | string[];

export const networkHosts = (network: Network = false): NetworkHosts =>
  network === false ? [] : network;

// `network`: the hosts that the agent can reach besides its provider
export const permissionsSchema = z.strictObject({
  write: z.boolean().optional(),
  shell: z.boolean().optional(),
  network: networkSchema.optional(),
});

export type Permissions = z.infer<typeof permissionsSchema>;

export type StepPermissions = { write: boolean; shell: boolean; network: NetworkHosts };

export const stepPermissions = ({
  permissions,
}: {
  permissions?: Permissions;
}): StepPermissions => ({
  write: permissions?.write ?? true,
  shell: permissions?.shell ?? true,
  network: networkHosts(permissions?.network),
});

export const canWrite = (step: { permissions?: Permissions }) => stepPermissions(step).write;

// `anyHost`: only `network: true`, because the provider of the agent reaches the host.
export type ToolNeed = "write" | "shell" | "network" | "anyHost";

export const toolNeedChecks: Record<
  ToolNeed,
  { isAllowed: (permissions: StepPermissions) => boolean; permission: string }
> = {
  write: { isAllowed: ({ write }) => write, permission: "write: true" },
  shell: { isAllowed: ({ shell }) => shell, permission: "shell: true" },
  network: {
    isAllowed: ({ network }) => network === true || network.length > 0,
    permission: "a network host",
  },
  anyHost: { isAllowed: ({ network }) => network === true, permission: "network: true" },
};
