import { realpathSync } from "node:fs";
import { join } from "node:path";

import { inlinedCssPackages } from "@halinka/ui/inlinedCssPackages";
import { licensesOfBundle, thirdPartyLicensesText } from "@halinka/utils/licenses";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

const packageFolder = (name: string) =>
  realpathSync(join(import.meta.dirname, "node_modules", name));

// Their bundled code has ids outside their folders: Vite and Rolldown helpers, monaco's DOMPurify copy.
const hiddenPackages = [
  join(packageFolder("vite"), "package.json"),
  join(packageFolder("vite"), "../rolldown/package.json"),
  join(packageFolder("monaco-editor"), "../dompurify/package.json"),
];

const thirdPartyLicenses = (): Plugin => {
  let root = "";
  return {
    name: "third-party-licenses",
    apply: "build",
    configResolved: (config) => {
      root = config.root;
    },
    async generateBundle(_options, bundle) {
      const files = Object.values(bundle).flatMap((file) =>
        file.type === "chunk" ? file.moduleIds : file.originalFileNames,
      );
      const licenses = await licensesOfBundle(
        [
          ...files,
          ...inlinedCssPackages,
          ...hiddenPackages,
          join(packageFolder("tailwindcss"), "package.json"),
        ],
        root,
        join(import.meta.dirname, "third-party-licenses"),
      );
      this.emitFile({
        type: "asset",
        fileName: "THIRD_PARTY_LICENSES.txt",
        source: thirdPartyLicensesText(licenses),
      });
    },
  };
};

export default defineConfig({
  plugins: [react(), tailwindcss(), thirdPartyLicenses()],
  // @halinka/ui and the portal both import recharts; the chart context needs one copy.
  resolve: { dedupe: ["recharts"] },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:7070",
        changeOrigin: true,
        // http-proxy does not end the response when the server drops it, so a stream stays open.
        configure: (proxy) =>
          proxy.on("proxyRes", (proxyRes, _request, response) =>
            proxyRes.on("close", () => {
              if (!response.writableEnded) response.end();
            }),
          ),
      },
    },
  },
  test: { restoreMocks: true },
});
