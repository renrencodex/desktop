import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";

import { resolveDesktopBuildConfig } from "./src/config";

export default defineConfig(({ mode }) => {
  resolveDesktopBuildConfig(loadEnv(mode, process.cwd(), "VITE_"), mode === "production");
  return {
    plugins: [react(), tailwindcss()],
    publicDir: "../../packages/native-client-ui/public",
    clearScreen: false,
    server: { strictPort: true },
  };
});
