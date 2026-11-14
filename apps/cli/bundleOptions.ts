import type { BuildOptions } from "esbuild";

// PGlite and the devcontainer CLI find their files by path.
export const externalPackages = ["@devcontainers/cli", "@electric-sql/pglite"];

// Flat in dist: the code finds its files next to itself with `import.meta.url`.
export const bundleOptions = {
  absWorkingDir: import.meta.dirname,
  entryPoints: ["src/main.ts"],
  outdir: "dist",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node24",
  metafile: true,
  // Native addons of bundled packages, which load them in a `try`.
  external: [...externalPackages, "*.node"],
  // Bundled CommonJS packages use `require`, `__dirname` and `__filename`.
  banner: {
    js: [
      'import { createRequire as createRequireOfBundle } from "node:module";',
      "const require = createRequireOfBundle(import.meta.url);",
      "const __dirname = import.meta.dirname;",
      "const __filename = import.meta.filename;",
    ].join(" "),
  },
} satisfies BuildOptions;
