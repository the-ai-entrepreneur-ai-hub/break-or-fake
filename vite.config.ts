import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: Object.fromEntries(
      ["/api", "/health", "/ready", "/capture"].map((path) => [path, "http://localhost:3000"]),
    ),
  },
});
