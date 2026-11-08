import { spawn } from "node:child_process";
const backend = spawn(process.execPath, ["--env-file-if-exists=.env", "--import", "tsx", "scripts/serve.ts"], {
  stdio: "inherit", env: { ...process.env, APP_ORIGIN: process.env.APP_ORIGIN ?? "http://127.0.0.1:5173" },
});
const frontend = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5173", "--strictPort"], { stdio: "inherit" });
let stopping = false;
function stop(code: number) {
  if (stopping) return;
  stopping = true; backend.kill("SIGTERM"); frontend.kill("SIGTERM"); process.exitCode = code;
}
backend.on("exit", (code) => stop(code ?? 1));
frontend.on("exit", (code) => stop(code ?? 1));
process.on("SIGINT", () => stop(0)); process.on("SIGTERM", () => stop(0));
