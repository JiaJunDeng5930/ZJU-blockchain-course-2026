import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "reload-verified-program",
      handleHotUpdate(context) {
        // A new extracted program invalidates OCaml controller closures retained by React refresh.
        if (
          /\/(?:generated\/(?:dex_logic\.js|abis\.ts)|shared\/deployment\.json)$/.test(
            context.file,
          )
        ) {
          context.server.ws.send({ type: "full-reload" });
          return [];
        }
      },
    },
  ],
  resolve: { dedupe: ["react", "react-dom", "viem"] },
  publicDir: "../shared",
  server: {
    port: 3000,
    proxy: {
      "/api/simulation": `http://127.0.0.1:${process.env.SIMULATION_PORT ?? 8787}`,
    },
  },
  build: {
    outDir: "build",
  },
  preview: {
    proxy: {
      "/api/simulation": `http://127.0.0.1:${process.env.SIMULATION_PORT ?? 8787}`,
    },
    port: 4173,
    strictPort: true,
  },
});
