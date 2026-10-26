import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ["react", "react-dom", "ethers"] },
  publicDir: "../shared",
  server: {
    port: 3000,
    proxy: { "/api/simulation": "http://127.0.0.1:8787" },
  },
  build: {
    outDir: "build",
  },
  preview: {
    proxy: { "/api/simulation": "http://127.0.0.1:8787" },
    port: 4173,
    strictPort: true,
  },
});
