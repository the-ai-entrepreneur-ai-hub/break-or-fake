import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import auditBrowser from "../test/browser/acceptance.mjs";
import endToEnd from "../test/browser/end-to-end.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(root, process.env.QA_OUTPUT_DIR ?? ".notes/verification/browser");
await mkdir(outputDirectory, { recursive: true });
let child, browser, childLog = "";
try {
  let baseURL = process.env.QA_BASE_URL, emptyURL = process.env.QA_EMPTY_URL;
  if (!baseURL && !emptyURL) {
    child = fork(resolve(root, "test/support/ui-server.ts"), [], {
      execArgv: ["--import", "tsx"], cwd: root, silent: true,
    });
    child.stdout.on("data", chunk => { childLog += chunk; });
    child.stderr.on("data", chunk => { childLog += chunk; });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 20_000);
    try {
      [ { baseURL, emptyURL } ] = await Promise.race([
        once(child, "message"),
        once(child, "exit").then(([code]) => { throw Error(`QA server exited ${code}: ${childLog}`); }),
      ]);
    } finally { clearTimeout(timeout); }
  }
  for (const value of [baseURL, emptyURL]) {
    const url = new URL(value);
    assert.equal(url.protocol, "http:");
    assert.equal(url.hostname, "127.0.0.1", "QA must remain local");
    const state = await fetch(new URL("/__qa/state", url)).then(response => response.json());
    assert.equal(state.isolated, true, "Refuse to audit a non-QA server");
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(15_000);
  const result = await auditBrowser(page, { baseURL, emptyURL, outputDirectory });
  await writeFile(resolve(outputDirectory, "results.json"), JSON.stringify(result, null, 2) + "\n");
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.failures.length, 0, "Computed style/overflow regression");
  assert.ok(result.assertions.length >= 47 && result.assertions.every(row => row.pass), "Missing browser assertions");
  assert.ok(result.views >= 50, "Missing audited states");
  await page.goto(new URL("/shop", baseURL).href, { waitUntil: "networkidle" });
  const catalogImages = await page.evaluate(async () => Promise.all(
    ["mug", "linen", "cup"].map(async name => {
      const source = `/assets/${name}.jpg`;
      const response = await fetch(source);
      const image = new Image();
      image.src = source;
      await image.decode();
      return { name, status: response.status, type: response.headers.get("content-type"),
        width: image.naturalWidth, height: image.naturalHeight };
    }),
  ));
  for (const image of catalogImages) {
    assert.equal(image.status, 200);
    assert.match(image.type, /^image\/jpeg/);
    assert.equal(image.width, 1200);
    assert.equal(image.height, 800);
  }
  await page.screenshot({ path: resolve(outputDirectory, "catalog-images.png"), fullPage: true });
  const flows = await endToEnd(browser, { baseURL: emptyURL, outputDirectory });
  console.log(JSON.stringify({
    assertions: result.assertions.length, views: result.views, minFont: result.minFont,
    minContrast: result.minContrast, failures: result.failures.length,
    endToEndAssertions: flows.assertions.length, endToEndViews: flows.views.length, outputDirectory,
    catalogImages,
  }, null, 2));
} finally {
  await browser?.close();
  if (child && child.exitCode === null) {
    const closed = once(child, "exit");
    child.kill("SIGTERM");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    await closed;
    clearTimeout(timeout);
  }
  if (childLog) await writeFile(resolve(outputDirectory, "server.log"), childLog);
}
