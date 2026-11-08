import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const preload = `
import { writeFileSync } from "node:fs";
const calls = [];
const violations = [];
const scenario = process.env.TEST_MODEL_SCENARIO;
const zero = { prompt: 0, completion: 0, request: 0, image: 0 };
const ids = ["a", "b", "c", "d", "unknown"];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
process.on("exit", () => writeFileSync("http-log.json", JSON.stringify({ calls, violations })));
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const method = init.method || "GET";
  const auth = new Headers(init.headers).has("authorization");
  const body = init.body ? JSON.parse(String(init.body)) : null;
  calls.push({ url, method, auth, model: body?.model });
  if (url === "https://openrouter.ai/api/v1/models") {
    if (scenario === "catalog-error") return json({ error: "private-provider-body" }, 503);
    if (scenario === "invalid-metadata") return json({ data: "private-provider-body" });
    return json({ data: [...ids.map((id) => ({
      id: "vendor/" + id + ":free", name: id, context_length: 10000,
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      pricing: zero, supported_parameters: ["response_format", "max_tokens"],
    })), { id: "vendor/paid", pricing: { prompt: 1, completion: 1 } }] });
  }
  if (url === "https://openrouter.ai/api/v1/key") {
    if (scenario === "key-transport-error") throw new Error("test-secret-never-output private-provider-body");
    return scenario === "invalid-key" ? json({ error: "private-provider-body" }, 401) :
      json({ data: { is_free_tier: true, free_model_daily_requests: { used: 1, limit: 50 }, private: "private-provider-body" } });
  }
  if (method === "POST" && url === "https://openrouter.ai/api/v1/chat/completions") {
    if (!body.model.endsWith(":free")) violations.push("paid model requested");
    if (JSON.stringify(body.provider?.max_price) !== JSON.stringify(zero)) violations.push("missing zero-price guard");
    if (body.provider?.require_parameters !== true) violations.push("parameters not required");
    if (body.response_format?.type !== "json_object") violations.push("missing JSON mode");
    const images = body.messages?.flatMap((message) => Array.isArray(message.content) ?
      message.content.filter((part) => part.type === "image_url") : []) || [];
    if (images.length !== 2) violations.push("not a two-image probe");
    if (scenario === "blocked" || body.model === "vendor/a:free") return json({ error: "private-provider-body" }, 429);
    const model = body.model === "vendor/b:free" ? "vendor/shared:free" :
      body.model === "vendor/c:free" ? "VENDOR/shared" : body.model;
    return json({ model, usage: { prompt_tokens: 10, completion_tokens: 10 },
      choices: [{ finish_reason: "stop", message: { content: '{"colors":["red","blue"]}' } }] });
  }
  const id = ids.find((id) => url === "https://openrouter.ai/vendor/" + id + ":free");
  if (id) {
    if (id === "unknown" || scenario === "no-usage") return new Response("<html>no daily rows</html>");
    const midnight = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
    const rows = Array.from({ length: 9 }, (_, index) => ({
      date: new Date(midnight - (index + 1) * 86400000).toISOString().slice(0, 10) + " 00:00:00",
      model_permaslug: "vendor/" + id, variant: "free",
      total_prompt_tokens: (4 - ids.indexOf(id)) * 100, total_completion_tokens: 1, count: 1,
    }));
    return new Response("<script>" + rows.map((row) => JSON.stringify(row)).join(",") + "</script>");
  }
  throw new Error("unexpected fake endpoint; no network fallback");
};
`;

async function runCli(scenario: string, key: boolean, permissiveReport = false) {
  const directory = await mkdtemp(join(tmpdir(), "break-or-fake models "));
  try {
    await mkdir(join(directory, "scripts"));
    await mkdir(join(directory, "lib"));
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    for (const path of ["scripts/openrouter-models.ts", "lib/openrouter.ts", "lib/vision.ts"])
      await copyFile(join(root, path), join(directory, path));
    await symlink(join(root, "node_modules"), join(directory, "node_modules"));
    await writeFile(join(directory, "mock-http.mjs"), preload);
    const environment = "UNCHANGED_TEST_SETTING=preserve-dollar-$-and-quotes\n";
    await writeFile(join(directory, ".env"), environment);
    const reportPath = join(directory, ".notes/openrouter-models.json");
    if (permissiveReport) {
      await mkdir(join(directory, ".notes"));
      await writeFile(reportPath, "{}\n");
      await chmod(reportPath, 0o644);
    }
    const child = spawnSync(process.execPath, [
      "--import", "tsx", "--import", join(directory, "mock-http.mjs"), join(directory, "scripts/openrouter-models.ts"),
    ], {
      cwd: directory, encoding: "utf8", timeout: 10_000,
      env: { ...process.env, OPENROUTER_API_KEY: key ? "test-secret-never-output" : "", TEST_MODEL_SCENARIO: scenario },
    });
    assert.equal(child.error, undefined);
    const output = child.stdout + child.stderr;
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal((await stat(reportPath)).mode & 0o7777, 0o600);
    const http = JSON.parse(await readFile(join(directory, "http-log.json"), "utf8"));
    assert.equal(await readFile(join(directory, ".env"), "utf8"), environment);
    assert.doesNotMatch(output + JSON.stringify(report), /test-secret-never-output|private-provider-body/);
    assert.ok(http.calls.filter((call: { url: string }) => call.url !== "https://openrouter.ai/api/v1/key")
      .every((call: { method: string; auth: boolean }) => call.method === "POST" || !call.auth));
    return { code: child.status, output, report, http };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("model CLI reports usage but emits no configuration or inference without a key", async () => {
  const result = await runCli("fallback", false);
  assert.equal(result.code, 77);
  assert.equal(result.report.status, "blocked");
  assert.deepEqual(result.report.picks, []);
  assert.equal(result.http.calls.filter((call: { method: string }) => call.method === "POST").length, 0);
  assert.doesNotMatch(result.output, /OPENROUTER_MODELS=/);
  assert.equal(result.report.ranked.find((model: { id: string }) => model.id === "vendor/a:free").tokens, 2807);
});

test("model CLI selects working distinct free models rather than blindly taking the top three", async () => {
  const result = await runCli("fallback", true);
  assert.equal(result.code, 0);
  assert.deepEqual(result.http.violations, []);
  assert.deepEqual(result.report.picks, ["vendor/b:free", "vendor/d:free"]);
  assert.equal(result.report.status, "ready");
  assert.match(result.output, /OPENROUTER_MODELS=vendor\/b:free,vendor\/d:free/);
  assert.equal(result.report.probes.length, 4);
  assert.ok(result.report.sources.every((source: { sha256: string; url: string; rows: unknown[] }) =>
    /^[a-f0-9]{64}$/.test(source.sha256) && source.url.startsWith("https://openrouter.ai/vendor/") && Array.isArray(source.rows)));
  assert.equal(result.report.window.days, 7);
  assert.match(result.report.citation, /Source: OpenRouter/);
});

for (const scenario of ["blocked", "invalid-key", "no-usage"]) {
  test(`model CLI refuses configuration for ${scenario}`, async () => {
    const result = await runCli(scenario, true);
    assert.equal(result.code, 77);
    assert.equal(result.report.status, "blocked");
    assert.deepEqual(result.report.picks, []);
    assert.doesNotMatch(result.output, /OPENROUTER_MODELS=/);
    if (scenario !== "blocked") assert.equal(result.http.calls.filter((call: { method: string }) => call.method === "POST").length, 0);
  });
}

for (const scenario of ["catalog-error", "invalid-metadata", "key-transport-error"]) {
  test(`model CLI records a safe error for ${scenario}`, async () => {
    const result = await runCli(scenario, true);
    assert.equal(result.code, 1);
    assert.equal(result.report.status, "error");
    assert.deepEqual(result.report.picks, []);
    assert.doesNotMatch(result.output, /OPENROUTER_MODELS=/);
    assert.equal(result.http.calls.filter((call: { method: string }) => call.method === "POST").length, 0);
  });
}

for (const [scenario, status, code] of [["fallback", "ready", 0], ["blocked", "blocked", 77], ["catalog-error", "error", 1]] as const) {
  test(`model CLI makes an existing permissive ${status} report private`, async () => {
    const result = await runCli(scenario, true, true);
    assert.equal(result.report.status, status);
    assert.equal(result.code, code);
  });
}
