import { cp, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

type PackageJson = {
  name: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

export const fallbackLicensesFolder = join(import.meta.dirname, "third-party-licenses");

// The copy holds no dependency of the package, so the package must have none.
export const copyExternalPackage = async (from: string, to: string) => {
  const {
    name,
    dependencies = {},
    optionalDependencies = {},
  }: PackageJson = JSON.parse(await readFile(join(from, "package.json"), "utf8"));
  if (Object.keys({ ...dependencies, ...optionalDependencies }).length > 0) {
    throw new Error(`${name} has dependencies. Copy them to dist/node_modules too, or bundle it.`);
  }
  await cp(from, to, {
    recursive: true,
    dereference: true,
    // pnpm adds a `node_modules/.bin` with paths of this machine.
    filter: (source) => relative(from, source) !== "node_modules",
  });
};
