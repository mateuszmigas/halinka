export type AuthConfig = {
  publicUrl: string;
  secret: string;
  github: { clientId: string; clientSecret: string };
  firstAdminLogin: string;
  trustedProxy?: string;
};

const minSecretLength = 32;

const names = [
  "HALINKA_PUBLIC_URL",
  "HALINKA_AUTH_SECRET",
  "HALINKA_GITHUB_CLIENT_ID",
  "HALINKA_GITHUB_CLIENT_SECRET",
  "HALINKA_ADMIN_GITHUB",
] as const;

export const isLocalHostname = (hostname: string) =>
  hostname === "127.0.0.1" ||
  hostname === "localhost" ||
  hostname === "::1" ||
  hostname === "[::1]";

const requireValidPublicUrl = (value: string) => {
  const url = URL.parse(value);
  if (url?.protocol !== "https:" && !(url?.protocol === "http:" && isLocalHostname(url.hostname))) {
    throw new Error(`HALINKA_PUBLIC_URL must be an https URL. Got "${value}".`);
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`HALINKA_PUBLIC_URL must have no path. Got "${value}".`);
  }
};

export const authConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): AuthConfig | undefined => {
  const missing = names.filter((name) => !env[name]);
  if (missing.length === names.length) return undefined;
  if (missing.length > 0) throw new Error(`Set also ${missing.join(", ")}, or none of them.`);
  const secret = env.HALINKA_AUTH_SECRET!;
  if (secret.length < minSecretLength) {
    throw new Error(`HALINKA_AUTH_SECRET must have at least ${minSecretLength} characters.`);
  }
  const publicUrl = env.HALINKA_PUBLIC_URL!;
  requireValidPublicUrl(publicUrl);
  return {
    publicUrl: new URL(publicUrl).origin,
    secret,
    github: {
      clientId: env.HALINKA_GITHUB_CLIENT_ID!,
      clientSecret: env.HALINKA_GITHUB_CLIENT_SECRET!,
    },
    firstAdminLogin: env.HALINKA_ADMIN_GITHUB!,
    ...(env.HALINKA_TRUSTED_PROXY && { trustedProxy: env.HALINKA_TRUSTED_PROXY }),
  };
};
