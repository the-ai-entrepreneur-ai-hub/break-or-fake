import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export class AppError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export const newCapability = (): string => randomBytes(32).toString("base64url");
export const tokenDigest = (token: string): string => createHash("sha256").update(token).digest("hex");
export const equalSecret = (a: string, b: string): boolean =>
  timingSafeEqual(Buffer.from(tokenDigest(a)), Buffer.from(tokenDigest(b)));

export class SellerSessions {
  private readonly sessions = new Map<string, { expires: number; role: "seller" | "viewer" }>();
  readonly configured: boolean;
  readonly viewerConfigured: boolean;
  constructor(private readonly password: string, private readonly now: () => number = Date.now, private readonly viewerPassword = "") {
    this.configured = password.length >= 12;
    this.viewerConfigured = viewerPassword.length >= 12;
    if (this.configured && this.viewerConfigured && equalSecret(password, viewerPassword)) throw new AppError(503, "Use different seller and viewer passwords.");
  }
  login(password: string): string {
    if (!this.configured && !this.viewerConfigured) throw new AppError(503, "Seller access is not configured (passwords need at least 12 characters).");
    const role = typeof password !== "string" ? null : this.configured && equalSecret(password, this.password) ? "seller" : this.viewerConfigured && equalSecret(password, this.viewerPassword) ? "viewer" : null;
    if (!role) throw new AppError(401, "Incorrect password.");
    for (const [key, session] of this.sessions) if (session.expires <= this.now()) this.sessions.delete(key);
    if (this.sessions.size >= 100) throw new AppError(429, "Too many seller sessions.");
    const token = newCapability();
    this.sessions.set(tokenDigest(token), { expires: this.now() + 8 * 60 * 60_000, role });
    return token;
  }
  valid(token: string): boolean {
    return this.role(token) !== null;
  }
  role(token: string): "seller" | "viewer" | null {
    if (typeof token !== "string" || token.length > 128) return null;
    const digest = tokenDigest(token), session = this.sessions.get(digest);
    if (!session) return null;
    if (session.expires <= this.now()) { this.sessions.delete(digest); return null; }
    return session.role;
  }
  logout(token: string): void { this.sessions.delete(tokenDigest(token)); }
}

export class RateLimiter {
  private readonly entries = new Map<string, { count: number; expires: number }>();
  constructor(private readonly maximum: number, private readonly window: number, private readonly now: () => number = Date.now) {}
  take(key: string): boolean {
    const now = this.now(), entry = this.entries.get(key);
    if (!entry || entry.expires <= now) {
      if (this.entries.size >= 10_000) {
        for (const [id, value] of this.entries) if (value.expires <= now) this.entries.delete(id);
        if (this.entries.size >= 10_000) return false;
      }
      this.entries.set(key, { count: 1, expires: now + this.window });
      return true;
    }
    if (entry.count >= this.maximum) return false;
    entry.count++;
    return true;
  }
}
