import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
