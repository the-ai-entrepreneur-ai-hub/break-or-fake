import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";

export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
export interface CaptureSession {
  id: string;
  orderId: string;
  nonce: string;
  code: string;
  issuedAt: number;
  expiresAt: number;
}
export interface CaptureSubmission {
  orderId: string;
  nonce: string;
  frames: { mimeType: string; data: string }[];
}

export class CaptureSessions {
  private readonly sessions = new Map<string, CaptureSession>();
  constructor(private readonly now: () => number = Date.now) {}

  issue(orderId: string): CaptureSession {
    if (typeof orderId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(orderId)) throw new Error("invalid order id");
    const issuedAt = this.now();
    for (const [id, session] of this.sessions) if (session.expiresAt <= issuedAt) this.sessions.delete(id);
    if (this.sessions.size >= 1000) throw new Error("too many active sessions");
    const session = {
      id: randomUUID(), orderId, nonce: randomBytes(32).toString("hex"),
      code: String(randomInt(100, 1000)), issuedAt, expiresAt: issuedAt + 120_000,
    };
    this.sessions.set(session.id, session);
    return { ...session };
  }

  consume(id: string, submission: CaptureSubmission): { session: CaptureSession; frames: Buffer[]; hashes: string[] } {
    const session = this.sessions.get(id);
    if (!session) throw new Error("unknown or used session");
    if (this.now() >= session.expiresAt) {
      this.sessions.delete(id);
      throw new Error("expired session");
    }
    if (!submission || typeof submission !== "object") throw new Error("invalid submission");
    if (submission.orderId !== session.orderId || submission.nonce !== session.nonce) throw new Error("session binding mismatch");
    if (!Array.isArray(submission.frames) || submission.frames.length !== 3) throw new Error("three frames required");
    const frames = submission.frames.map((frame) => {
      if (!frame || !["image/jpeg", "image/png"].includes(frame.mimeType) || typeof frame.data !== "string" ||
          !frame.data || frame.data.length > Math.ceil(MAX_FRAME_BYTES / 3) * 4 ||
          frame.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.data)) throw new Error("invalid frame");
      const bytes = Buffer.from(frame.data, "base64");
      if (!bytes.length || bytes.length > MAX_FRAME_BYTES || bytes.toString("base64") !== frame.data) throw new Error("invalid frame size or encoding");
      return bytes;
    });
    const hashes = frames.map((bytes) => createHash("sha256").update(bytes).digest("hex"));
    if (new Set(hashes).size !== 3) throw new Error("three distinct frames required");
    this.sessions.delete(id);
    return { session: { ...session }, frames, hashes };
  }
}
