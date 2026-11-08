import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { AppError } from "./app-security.js";

export class AppStore {
  readonly directory: string;
  private readonly db: DatabaseSync;
  private pendingOrders = 0;
  private pendingImages = 0;
  private reservedBytes = 0;

  constructor(directory: string) {
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    mkdirSync(join(this.directory, "evidence"), { recursive: true, mode: 0o700 });
    const path = join(this.directory, "app.sqlite");
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS documents (
        kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY (kind, id)
      );
      CREATE TABLE IF NOT EXISTS leases (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL
      );
      PRAGMA user_version=1;
    `);
  }

  get<T = unknown>(kind: string, id: string): T | undefined {
    const row = this.db.prepare("SELECT body FROM documents WHERE kind=? AND id=?").get(kind, id);
    return row ? JSON.parse(row.body as string) as T : undefined;
  }

  all<T = unknown>(kind: string): T[] {
    return this.db.prepare("SELECT body FROM documents WHERE kind=? ORDER BY rowid").all(kind)
      .map((row) => JSON.parse(row.body as string) as T);
  }

  private count(kind: string): number {
    return Number(this.db.prepare("SELECT COUNT(*) AS count FROM documents WHERE kind=?").get(kind)!.count);
  }

  reserveOrder(): () => void {
    if (this.count("orders") + this.pendingOrders >= 5000) throw new AppError(503, "Demo storage capacity is full. Ask the seller for help.");
    this.pendingOrders++;
    let active = true;
    return () => { if (active) { this.pendingOrders--; active = false; } };
  }

  reserveImages(sizes: number[]): () => void {
    if (this.count("images") + this.pendingImages + sizes.length > 5000) throw new AppError(503, "Demo storage capacity is full. Ask the seller for help.");
    let used = 0;
    for (const directory of [this.directory, join(this.directory, "evidence")]) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isFile()) {
          try { used += statSync(join(directory, entry.name)).size; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
      }
    }
    // Reserve file bytes and SQLite bookkeeping before any asynchronous write.
    const bytes = sizes.reduce((sum, size) => sum + size + 64 * 1024, 0);
    if (used + this.reservedBytes + bytes > 512 * 1024 * 1024) throw new AppError(503, "Demo storage capacity is full. Ask the seller for help.");
    this.reservedBytes += bytes; this.pendingImages += sizes.length;
    let active = true;
    return () => {
      if (active) { this.reservedBytes -= bytes; this.pendingImages -= sizes.length; active = false; }
    };
  }

  put(kind: string, id: string, value: unknown): void {
    this.db.prepare("INSERT INTO documents(kind,id,body) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body")
      .run(kind, id, JSON.stringify(value));
  }

  remove(kind: string, id: string): void {
    this.db.prepare("DELETE FROM documents WHERE kind=? AND id=?").run(kind, id);
  }

  acquire(id: string, owner: string, now: number, ttl: number): boolean {
    const result = this.db.prepare(`
      INSERT INTO leases(id,owner,expires) VALUES(?,?,?)
      ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires=excluded.expires
      WHERE leases.expires<=?
    `).run(id, owner, now + ttl, now);
    return result.changes === 1;
  }

  release(id: string, owner: string): void {
    this.db.prepare("DELETE FROM leases WHERE id=? AND owner=?").run(id, owner);
  }

  close(): void { this.db.close(); }
}
