import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { makeCaptureHandler } from "../lib/capture-server.js";

const local = process.argv.includes("--local");
const key = process.env.CAPTURE_TLS_KEY_BASE64;
const cert = process.env.CAPTURE_TLS_CERT_BASE64;
if (!local && (!key || !cert)) {
  console.log("capture skipped: HTTPS certificate material is absent; keep it in .env");
  process.exitCode = 77;
} else {
  const handler = makeCaptureHandler(new URL("../.notes/captures/", import.meta.url).pathname);
  const server = local ? httpServer(handler) : httpsServer({
    key: Buffer.from(key!, "base64"), cert: Buffer.from(cert!, "base64"),
  }, handler);
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  const host = local ? "127.0.0.1" : process.env.CAPTURE_HOST || "127.0.0.1";
  const port = Number(process.env.CAPTURE_PORT || 3443);
  server.listen(port, host, () => console.log(`Capture spike: ${local ? "http" : "https"}://${host}:${port}. No payments or automatic decisions.`));
}
