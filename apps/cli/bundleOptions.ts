import type { BuildOptions, Plugin } from "esbuild";

// An npm package stays external: PGlite and the devcontainer CLI find their files by path.
const npmPackagesStayExternal: Plugin = {
  name: "npm-packages-stay-external",
  setup: (pluginBuild) => {
    pluginBuild.onResolve({ filter: /^[^./]/ }, ({ path, kind }) =>
      kind === "entry-point" || path.startsWith("@halinka/") ? undefined : { path, external: true },
    );
  },
};

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
  plugins: [npmPackagesStayExternal],
} satisfies BuildOptions;
