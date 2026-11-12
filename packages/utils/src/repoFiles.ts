export const mib = 1024 * 1024;
export const maxFileMib = 1;
export const maxTotalMib = 4;
export const maxFiles = 200;

export const isRepoFilePath = (path: string) =>
  !path.startsWith("/") &&
  !path.includes("\\") &&
  !path.includes("\0") &&
  path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
