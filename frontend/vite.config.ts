import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ["react", "react-dom", "ethers"] },
  publicDir: "../shared",
  server: {
    port: 3000,
  },
  build: {
    outDir: "build",
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
});
