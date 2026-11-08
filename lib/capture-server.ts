import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CaptureSessions, type CaptureSubmission } from "./capture.js";

const PUBLIC = new URL("../public/", import.meta.url);
const BODY_LIMIT = 17 * 1024 * 1024;

export function makeCaptureHandler(directory: string) {
  const sessions = new CaptureSessions();
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'");
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    try {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (request.method === "GET" && ["/", "/capture.js", "/capture.css"].includes(pathname)) {
        const file = pathname === "/" ? "capture.html" : pathname.slice(1);
        response.setHeader("content-type", file.endsWith(".html") ? "text/html; charset=utf-8" : file.endsWith(".js") ? "text/javascript" : "text/css");
        response.end(await readFile(new URL(file, PUBLIC)));
        return;
      }
      if (request.method !== "POST") { send(404, { error: "Not found" }); return; }
      const origin = request.headers.origin;
      if (!origin || !/^https?:\/\//.test(origin) || new URL(origin).host !== request.headers.host) {
        send(403, { error: "Same-origin capture required" }); return;
      }
      if (request.headers["content-type"]?.split(";")[0] !== "application/json") {
        send(415, { error: "JSON required" }); return;
      }
      if (Number(request.headers["content-length"] ?? 0) > BODY_LIMIT) { send(413, { error: "Capture too large" }); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > BODY_LIMIT) { send(413, { error: "Capture too large" }); return; }
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (pathname === "/sessions") { send(201, sessions.issue(body?.orderId)); return; }
      const match = /^\/sessions\/([a-f0-9-]{36})\/frames$/.exec(pathname);
      if (!match) { send(404, { error: "Not found" }); return; }
      const captured = sessions.consume(match[1], body as CaptureSubmission);
      const receivedAt = Date.now();
      const folder = resolve(directory, captured.session.id);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const frames = await Promise.all(captured.frames.map(async (bytes, index) => {
        const mimeType = body.frames[index].mimeType as string;
        const name = `frame-${index + 1}.${mimeType === "image/png" ? "png" : "jpg"}`;
        await writeFile(resolve(folder, name), bytes, { flag: "wx", mode: 0o600 });
        return { name, mimeType, sha256: captured.hashes[index] };
      }));
      await writeFile(resolve(folder, "capture.json"), JSON.stringify({
        mode: "spike", session: captured.session, receivedAt, frames,
      }, null, 2), { flag: "wx", mode: 0o600 });
      send(201, { id: captured.session.id, status: "saved_for_measurement", moneyMoved: false });
    } catch (error) {
      if (!response.headersSent) send(400, { error: error instanceof Error && !("code" in error) ? error.message : "Capture could not be saved. Start a new session." });
      else response.end();
    }
  };
}
