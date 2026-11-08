import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

test("capture browser preserves standalone routes and authorizes application sessions", async () => {
  const source = await readFile(new URL("../public/capture.js", import.meta.url), "utf8");
  for (const app of [false, true]) {
    const handlers = new Map<string, (event: { preventDefault(): void }) => Promise<void>>();
    const element = (id: string) => ({
      id, value: "test-order", hidden: false, required: true, disabled: false, textContent: "", srcObject: null,
      play: async () => {}, replaceChildren() {}, append() {}, setAttribute() {},
      addEventListener(type: string, callback: (event: { preventDefault(): void }) => Promise<void>) { handlers.set(`${id}:${type}`, callback); },
    });
    const nodes = new Map<string, ReturnType<typeof element>>();
    const get = (id: string) => { if (!nodes.has(id)) nodes.set(id, element(id)); return nodes.get(id)!; };
    const calls: { path: string; headers: Record<string, string> }[] = [];
    const claim = "00000000-0000-0000-0000-000000000001", token = "a".repeat(43);
    const location = { pathname: "/capture", search: app ? `?claim=${claim}` : "", hash: app ? `#token=${token}` : "", href: "http://127.0.0.1/capture" };
    const storage = new Map<string, string>();
    const track = { label: "Back Camera", stop() {} };
    const navigator = { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track], getVideoTracks: () => [track] }) } };
    runInNewContext(source, {
      URL, URLSearchParams, AbortSignal, Date, console,
      document: { getElementById: get, querySelector: () => element("optional"), createElement: () => element("created"), title: "" },
      navigator, location, history: { replaceState() {} },
      sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
      window: { isSecureContext: true, addEventListener() {}, location, navigator },
      fetch: async (path: string, init: { headers: Record<string, string> }) => {
        calls.push({ path, headers: init.headers });
        return { ok: true, json: async () => ({ id: "session", orderId: "test-order", nonce: "nonce", code: "123", expiresAt: Date.now() + 120_000 }) };
      },
      setInterval: () => 1, clearInterval() {},
    });
    await handlers.get("start-form:submit")!({ preventDefault() {} });
    assert.equal(calls[0]?.path, app ? `/api/claims/${claim}/capture-sessions` : "/sessions");
    assert.equal(calls[0]?.headers.authorization, app ? `Bearer ${token}` : undefined);
    if (app) {
      assert.equal(get("order-field").hidden, true);
    }
  }
});

test("capture has one plain-language intro and no presentation-only labels", async () => {
  const html = await readFile(new URL("../public/capture.html", import.meta.url), "utf8");
  assert.match(html, /<h1>Three live photos of the damage<\/h1>/);
  assert.match(html, /<title>Live photos, Break or Fake<\/title>/);
  assert.equal((html.match(/class="intro"/g) ?? []).length, 1);
  assert.match(html, /Write the code on paper, keep it next to the damage, and take three photos from different angles\. You have two minutes\./);
  assert.doesNotMatch(html, /capture-mode|fresh perspective|camera shouldn.t be a barrier/i);
});

test("capture declares the existing SVG favicon", async () => {
  const html = await readFile(new URL("../public/capture.html", import.meta.url), "utf8");
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg">/);
  const favicon = new URL("../public/favicon.svg", import.meta.url);
  assert.match(await readFile(existsSync(favicon) ? favicon : new URL("../dist/favicon.svg", import.meta.url), "utf8"), /<svg\b/);
});
