import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import sharp from "sharp";
import { computedAudit } from "../test/browser/acceptance.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, process.env.QA_DOCKER_OUTPUT_DIR ?? ".notes/verification/docker");
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(resolve(tmpdir(), "refund-docker-qa-"));
const prefix = `refund-qa-${process.pid}-${Date.now()}`;
const image = process.env.QA_IMAGE ?? "break-or-fake:local-verified";
const prodVolume = `${prefix}-production`, qaVolume = `${prefix}-claims`, restoredVolume = `${prefix}-restored`;
const network = `${prefix}-local`, qaName = `${prefix}-app`, restoredName = `${prefix}-restored-app`;
const containers = [], volumes = [], assertions = [], views = [];
const passwords = { seller: randomBytes(24).toString("base64url"), viewer: randomBytes(24).toString("base64url") };
const environment = resolve(temporary, "runtime.env"), override = resolve(temporary, "compose.local.yaml");
const compose = ["compose", "--env-file", environment, "-p", prefix, "-f", resolve(root, "compose.yaml"), "-f", override];
let composeStarted = false, browser;
function check(condition, name) { assertions.push({ name, pass: !!condition }); assert.ok(condition, name); }
async function command(args, { timeout = 30_000, log, allowFailure = false } = {}) {
  const result = spawnSync("docker", args, { cwd: root, encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
  if (log) await writeFile(resolve(output, log), result.stdout + result.stderr);
  if (!allowFailure && result.status !== 0) throw Error(`Docker ${args[0]} failed (${result.status ?? result.signal ?? result.error}):\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}
const json = async args => JSON.parse(await command(args));
async function waitFor(action, message, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const result = await action(); if (result) return result; } catch { /* Wait for the application, not a fixed delay. */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw Error(message);
}
async function baseFor(name, port = "3000/tcp") {
  const [binding] = await json(["inspect", "--format", `{{json (index .NetworkSettings.Ports "${port}")}}`, name]) ?? [];
  assert.ok(binding, `Docker did not publish ${port} for ${name}`);
  check(binding.HostIp === "127.0.0.1", `${name} publishes only on loopback`);
  return `http://127.0.0.1:${binding.HostPort}`;
}
async function request(base, path, { method = "GET", body, cookie, token, origin = base } = {}) {
  return fetch(base + path, {
    method, headers: { ...(method === "POST" ? { origin, "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000),
  });
}
async function login(base, password, origin = base) {
  const response = await request(base, "/api/seller/login", { method: "POST", body: { password }, origin });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie").split(";")[0];
}
async function startQa(name, volume) {
  containers.push(name);
  await command(["run", "-d", "--init", "--name", name, "--network", network, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
    "--memory=1g", "--tmpfs", "/tmp:size=64m,mode=1777",
    "-p", "127.0.0.1::3100", "-p", "127.0.0.1::3101",
    "--mount", `type=volume,src=${volume},dst=/data`,
    "--mount", `type=bind,src=${resolve(root, "test/support")},dst=/app/test/support,readonly`,
    "-e", "QA_DATA_DIR=/data", "-e", "QA_HOST=0.0.0.0", "-e", "QA_PORT=3100", "-e", "QA_EMPTY_PORT=3101",
    image, "node", "--import", "tsx", "test/support/ui-server.ts"]);
  const base = await baseFor(name, "3100/tcp"), empty = await baseFor(name, "3101/tcp");
  await waitFor(async () => (await fetch(base + "/health")).ok, "QA container did not become healthy");
  return { base, empty };
}
try {
  await writeFile(environment, `APP_ORIGIN=https://localhost\nAPP_IMAGE=${image}\nSELLER_PASSWORD=${passwords.seller}\nSELLER_VIEWER_PASSWORD=${passwords.viewer}\n`, { mode: 0o600 });
  await mkdir(resolve(temporary, "inventory"));
  // Internal bridges cannot publish ports on Docker 29; keep loopback ingress and disable outbound masquerading.
  await writeFile(override, `services:\n  app:\n    cpus: 1.0\n    pids_limit: 128\n    env_file: !override\n      - ${environment}\n    ports: !override\n      - "127.0.0.1::3000"\n    volumes: !override\n      - data:/data\n      - ${resolve(temporary, "inventory")}:/inventory:ro\nvolumes:\n  data:\n    name: ${prodVolume}\nnetworks:\n  default:\n    driver_opts:\n      com.docker.network.bridge.enable_ip_masquerade: "false"\n`);
  await command(["version"], { log: "docker-version.log" });
  await command(["build", "--progress=plain", "-t", image, "."], { timeout: 420_000, log: "build.log" });
  const info = await json(["image", "inspect", "--format", '{"id":{{json .Id}},"architecture":{{json .Architecture}},"user":{{json .Config.User}}}', image]);
  check(info.user === "node", "Production image uses the unprivileged node user");
  await writeFile(resolve(output, "image.json"), JSON.stringify(info, null, 2) + "\n");
  await command(["run", "--rm", "--network=none", "--read-only", "--tmpfs", "/tmp:size=128m,mode=1777", "--tmpfs", "/app/.notes:size=128m,mode=1777", "--memory=2g",
    ...["test", "src", "Dockerfile", "compose.yaml"].flatMap(name => ["--mount", `type=bind,src=${resolve(root, name)},dst=/app/${name},readonly`]),
    image, "npm", "test"], { timeout: 180_000, log: "linux-tests.log" });
  check(true, "Full test suite passes inside the actual Node 24 Linux image");
  await command([...compose, "config", "--quiet"]);
  check(true, "Actual Compose file validates using isolated configuration, never the private .env");
  composeStarted = true; volumes.push(prodVolume);
  await command([...compose, "up", "-d", "--no-build", "app"], { timeout: 60_000, log: "compose-start.log" });
  const prodName = await command([...compose, "ps", "-q", "app"]);
  let prod = await baseFor(prodName);
  await waitFor(async () => (await fetch(prod + "/health")).ok, "Production entry point did not become healthy");
  check((await fetch(prod + "/ready")).status === 503, "Missing provider credentials produce honest production readiness 503");
  check((await fetch(prod + "/api/demo/claims")).status === 404, "Production image has no public sample claims API");
  check((await fetch(prod + "/__qa/state")).status === 404, "Production image has no QA control endpoint");
  const config = await fetch(prod + "/api/config").then(response => response.json());
  check(config.catalog.every(product => !product.available), "Missing payment credentials never enable checkout");
  check((await request(prod, "/api/seller/claims")).status === 401, "Production queue refuses anonymous access");
  check((await request(prod, "/api/seller/login", { method: "POST", origin: prod, body: { password: passwords.seller } })).status === 403, "Production mutations enforce the configured HTTPS origin");
  const viewer = await login(prod, passwords.viewer, "https://localhost");
  const session = await request(prod, "/api/seller/session", { cookie: viewer }).then(response => response.json());
  check(session.role === "viewer" && !session.canRefund, "Production viewer session is read only");
  check((await request(prod, "/api/seller/claims/00000000-0000-0000-0000-000000000001/refund", { method: "POST", cookie: viewer, origin: "https://localhost", body: { amountCents: 1 } })).status === 403, "Production viewer refund POST is forbidden before provider access");
  const filesystem = await command(["exec", prodName, "node", "-e", 'const fs=require("fs");if(process.getuid()===0||!fs.existsSync("/app/LICENSE")||fs.existsSync("/app/.env")||fs.existsSync("/app/.notes")||fs.existsSync("/app/test/support"))process.exit(1);try{fs.writeFileSync("/app/lib/__qa-readonly","x");process.exit(2)}catch(e){if(e.code!=="EROFS")throw e}fs.writeFileSync("/tmp/qa-tmp","ok");console.log("non-root, license present, no private/QA files, root read-only, tmpfs writable")']);
  check(!!filesystem, "Production filesystem enforces non-root/read-only/private-file boundaries");
  await command(["exec", prodName, "node", "--import", "tsx", "--input-type=module", "-e", 'import {AppStore} from "./lib/app-store.ts";const s=new AppStore("/data");s.put("release-check","marker",{value:"persistent"});s.close();']);
  await command([...compose, "restart", "app"], { timeout: 120_000 });
  prod = await baseFor(prodName);
  await waitFor(async () => (await fetch(prod + "/health")).ok, "Production restart did not recover");
  check((await request(prod, "/api/seller/claims", { cookie: viewer })).status === 401, "Production restart revokes old seller/viewer sessions");
  const marker = await command(["exec", prodName, "node", "--import", "tsx", "--input-type=module", "-e", 'import {AppStore} from "./lib/app-store.ts";const s=new AppStore("/data");console.log(JSON.stringify(s.get("release-check","marker")));s.close();']);
  check(JSON.parse(marker).value === "persistent", "Production SQLite state survives Compose restart");
  browser = await chromium.launch({ headless: true });
  for (const [width, height] of [[1280, 800], [390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    for (const path of ["/shop", "/seller", "/capture"]) {
      await page.goto(prod + path);
      if (path === "/shop") {
        await page.getByRole("heading", { name: "Test products.", exact: true }).waitFor();
        await page.locator(".loading-state").waitFor({ state: "hidden" });
        check(await page.locator(".product-card").count() === 0, `Production Docker hides unavailable catalog items at ${width}`);
        const ctas = await page.locator(".hero-actions a").evaluateAll(elements => elements.map(element => element.getBoundingClientRect().bottom <= innerHeight));
        check(ctas.length === 2 && ctas.every(Boolean), `Production Docker CTAs above fold at ${width}`);
      }
      if (path === "/seller") await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
      await page.evaluate(async () => document.fonts.ready);
      const audit = await page.evaluate(computedAudit);
      views.push({ path, width, ...audit });
      check(!audit.failures.length && !audit.overflow, `Production Docker ${path} type/contrast/overflow at ${width}`);
    }
    await page.screenshot({ path: resolve(output, `production-${width}.png`), fullPage: true });
    await page.close();
  }
  await browser.close(); browser = undefined;
  const limit = 17 * 1024 * 1024;
  const emptyBody = JSON.stringify({ orderId: "test-order", nonce: "123", frames: [] });
  const count = Math.floor((limit - Buffer.byteLength(emptyBody) + 1) / 2);
  const stressBody = JSON.stringify({ orderId: "test-order", nonce: "123", frames: Array(count).fill(0) }).padEnd(limit, " ");
  check(Buffer.byteLength(stressBody) === limit, "Stress input reaches the exact unchanged 17 MiB request limit");
  const stressPath = "/api/claims/00000000-0000-0000-0000-000000000001/capture-sessions/00000000-0000-0000-0000-000000000002/frames";
  const denseBody = ("{" + Array.from({ length: 1_200_000 }, (_, index) => `"k${index.toString(36)}":0`).join(",") + "}").padEnd(limit, " ");
  const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#abcdef" } }).png().toBuffer();
  const maximumImage = Buffer.alloc(4 * 1024 * 1024);
  png.copy(maximumImage);
  const maximumFramesBody = JSON.stringify({
    orderId: "test-order", nonce: "123",
    frames: Array(3).fill({ mimeType: "image/png", data: maximumImage.toString("base64") }),
  }).padEnd(limit, " ");
  const stress = [];
  for (const [name, body, expectedStatus] of [
    ["oversized-frame-array", stressBody, 400],
    ["dense-object", denseBody, 400],
    ["three-maximum-image-envelopes", maximumFramesBody, 404],
  ]) {
    check(Buffer.byteLength(body) === limit, `${name} reaches the exact unchanged 17 MiB limit`);
    await command([...compose, "restart", "app"], { timeout: 120_000 });
    prod = await baseFor(prodName);
    await waitFor(async () => (await fetch(prod + "/health")).ok, "Fresh production process did not recover");
    const started = Date.now();
    const responses = await Promise.all(Array.from({ length: 8 }, () => fetch(prod + stressPath, {
      method: "POST", headers: { origin: "https://localhost", "content-type": "application/json" }, body, signal: AbortSignal.timeout(30_000),
    }).then(async response => { await response.text(); return response.status; })));
    check(responses.every(status => status === expectedStatus), `Eight simultaneous ${name} requests return ${expectedStatus} in a fresh process`);
    check((await fetch(prod + "/health")).ok, `Production remains healthy after ${name}`);
    const memoryPeakBytes = Number(await command(["exec", prodName, "node", "-p", 'require("fs").readFileSync("/sys/fs/cgroup/memory.peak","utf8").trim()']));
    check(memoryPeakBytes < 1024 ** 3, `${name} stays below the unchanged 1 GiB limit`);
    stress.push({ name, requests: 8, bodyBytes: Buffer.byteLength(body), statuses: responses, elapsedMs: Date.now() - started, memoryPeakBytes });
  }
  await writeFile(resolve(output, "request-stress.json"), JSON.stringify({ bodyLimitBytes: limit, containerLimitBytes: 1024 ** 3, freshProcessPerCase: true, cases: stress }, null, 2) + "\n");
  await command(["network", "create", "--opt", "com.docker.network.bridge.enable_ip_masquerade=false", network]);
  for (const volume of [qaVolume, restoredVolume]) { volumes.push(volume); await command(["volume", "create", volume]); }
  const qa = await startQa(qaName, qaVolume);
  const browserResult = spawnSync(process.execPath, ["scripts/verify-browser.mjs"], {
    cwd: root, env: { ...process.env, QA_BASE_URL: qa.base, QA_EMPTY_URL: qa.empty, QA_OUTPUT_DIR: resolve(output, "browser") },
    encoding: "utf8", timeout: 150_000, maxBuffer: 4 * 1024 * 1024,
  });
  await writeFile(resolve(output, "browser.log"), browserResult.stdout + browserResult.stderr);
  assert.equal(browserResult.status, 0, browserResult.stderr);
  const browserSummary = JSON.parse(browserResult.stdout);
  const browserAssertions = browserSummary.assertions + browserSummary.endToEndAssertions;
  const browserViews = browserSummary.views + browserSummary.endToEndViews;
  assert.ok(Number.isSafeInteger(browserAssertions) && browserAssertions > 0 && Number.isSafeInteger(browserViews) && browserViews > 0, "Browser runner must report measured counts");
  check(true, `All ${browserAssertions} browser assertions and ${browserViews} views pass against the Linux container`);
  const state = await fetch(qa.base + "/__qa/state").then(response => response.json());
  const held = state.cases.held, waiting = state.cases.awaiting_live;
  const qaViewer = await login(qa.base, "viewer-password-for-tests");
  const claim = await request(qa.base, `/api/claims/${held.id}`, { cookie: qaViewer }).then(response => response.json());
  const evidencePath = claim.claim.evidence[0].url;
  check((await request(qa.base, evidencePath)).status === 403, "Container original evidence refuses anonymous reads");
  const originalBytes = Buffer.from(await request(qa.base, evidencePath, { cookie: qaViewer }).then(response => response.arrayBuffer()));
  check(originalBytes.length > 0, "Container viewer reads private original evidence");
  const cookie = await login(qa.base, "seller-password-for-tests");
  const capture = await request(qa.base, `/api/claims/${waiting.id}/capture-sessions`, { method: "POST", token: waiting.token, body: {} }).then(response => response.json());
  await request(qa.base, "/__qa/refund-mode", { method: "POST", body: { mode: "pending" } });
  const pending = await request(qa.base, `/api/seller/claims/${held.id}/refund`, { method: "POST", cookie, body: { amountCents: 2500 } }).then(response => response.json());
  check(pending.claim.status === "refund_pending" && pending.claim.refund.status !== "completed", "Pending refund is not mislabeled completed");
  const beforeRestart = await fetch(qa.base + "/__qa/state").then(response => response.json());
  check(beforeRestart.requestIds.includes(`refund_${held.id}`), "Money gate persists the original stable refund request identity");
  await command(["restart", "--time", "15", qaName], { timeout: 30_000 });
  qa.base = await baseFor(qaName, "3100/tcp");
  qa.empty = await baseFor(qaName, "3101/tcp");
  await waitFor(async () => (await fetch(qa.base + "/health")).ok, "QA restart did not recover");
  check((await request(qa.base, "/api/seller/claims", { cookie })).status === 401, "Container restart revokes authenticated sessions");
  const resumed = await request(qa.base, `/api/claims/${held.id}`, { token: held.token }).then(response => response.json());
  check(resumed.claim.status === "refund_pending", "Pending financial state survives process restart");
  const reused = await request(qa.base, `/api/claims/${waiting.id}/capture-sessions/${capture.id}/frames`, {
    method: "POST", token: waiting.token, body: { orderId: capture.orderId, nonce: capture.nonce, frames: Array(3).fill({ mimeType: "image/png", data: "Zg==" }) },
  });
  const rejectedCapture = await reused.json();
  check(reused.status === 400 && rejectedCapture.error === "Unknown capture session for this claim.", "Pre-restart capture sessions cannot be reused");
  await request(qa.base, "/__qa/advance", { method: "POST", body: { milliseconds: 61_000 } });
  await request(qa.base, "/__qa/refund-mode", { method: "POST", body: { mode: "complete" } });
  const settled = await request(qa.base, `/api/claims/${held.id}/refresh`, { method: "POST", token: held.token, body: {} }).then(response => response.json());
  check(settled.claim.status === "refunded" && settled.claim.refund.status === "completed", "Restarted app reconciles a genuinely completed adapter refund");
  const settledState = await fetch(qa.base + "/__qa/state").then(response => response.json());
  check(settledState.refundCalls === beforeRestart.refundCalls && settledState.refundOperations === beforeRestart.refundOperations, "Restart reconciliation makes no second refund call or operation");
  await command(["stop", "--time", "15", qaName], { timeout: 30_000 });
  await command(["run", "--rm", "--network=none", "--read-only", "--mount", `type=volume,src=${qaVolume},dst=/source,readonly`, "--mount", `type=volume,src=${restoredVolume},dst=/data`, image, "node", "-e",
    'const fs=require("fs");for(const name of fs.readdirSync("/source"))fs.cpSync("/source/"+name,"/data/"+name,{recursive:true,preserveTimestamps:true});']);
  const restored = await startQa(restoredName, restoredVolume);
  const restoredClaim = await request(restored.base, `/api/claims/${held.id}`, { token: held.token }).then(response => response.json());
  check(restoredClaim.claim.status === "refunded" && restoredClaim.claim.refund.id === settled.claim.refund.id, "Consistent volume backup/restore preserves the confirmed refund receipt");
  const restoredBytes = Buffer.from(await request(restored.base, evidencePath, { token: held.token }).then(response => response.arrayBuffer()));
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  check(hash(originalBytes) === hash(restoredBytes), "Backup/restore preserves original evidence bytes exactly");
  const restoredState = await fetch(restored.base + "/__qa/state").then(response => response.json());
  check(restoredState.refundCalls === settledState.refundCalls && JSON.stringify(restoredState.requestIds) === JSON.stringify(settledState.requestIds), "Backup/restore preserves payment identities without another refund");
  await waitFor(async () => (await json(["inspect", "--format", "{{json .State.Health.Status}}", prodName])) === "healthy", "Docker healthcheck did not become healthy", 65_000);
  check(true, "Docker's actual healthcheck reports healthy after production restart and stress");
  await command(["exec", prodName, "node", "-p", "JSON.stringify(process.versions)"], { log: "node-versions.json" });
  await command([...compose, "logs", "--no-color", "app"], { log: "production.log" });
  await writeFile(resolve(output, "results.json"), JSON.stringify({ image: info, syntheticAdapters: true, externalPayments: 0, assertions, views, browser: browserSummary, allPassed: true }, null, 2) + "\n");
  console.log(JSON.stringify({ image: info, dockerAssertions: assertions.length, productionViews: views.length, containerBrowserAssertions: browserAssertions, containerBrowserViews: browserViews, allPassed: true, output }, null, 2));
} catch (error) {
  if (composeStarted) await command([...compose, "logs", "--no-color", "app"], { log: "production-failure.log", allowFailure: true });
  for (const name of containers) await command(["logs", name], { log: `${name}.log`, allowFailure: true });
  await writeFile(resolve(output, "failure.json"), JSON.stringify({ error: String(error), assertions, views }, null, 2) + "\n");
  throw error;
} finally {
  await browser?.close();
  for (const name of containers.reverse()) await command(["rm", "-f", name], { allowFailure: true });
  if (composeStarted) await command([...compose, "down", "--timeout", "15"], { timeout: 30_000, allowFailure: true });
  for (const volume of volumes) await command(["volume", "rm", volume], { allowFailure: true });
  await command(["network", "rm", network], { allowFailure: true });
  await rm(temporary, { recursive: true, force: true });
}
