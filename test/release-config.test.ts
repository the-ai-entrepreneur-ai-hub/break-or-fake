import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the distributable image includes the project license", async () => {
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /^COPY(?: --chown=\S+)? LICENSE \.\//m);
  assert.doesNotMatch(dockerfile, /^COPY.*(?:\.env|\.notes|\.data|test\/support)/m);
});

test("Compose gives the server enough time to finish its 100-second shutdown", async () => {
  const compose = await readFile(new URL("../compose.yaml", import.meta.url), "utf8");
  const seconds = Number(/stop_grace_period:\s*(\d+)s/.exec(compose)?.[1]);
  assert.ok(seconds >= 110, "Do not SIGKILL the server before its own shutdown deadline");
  assert.match(compose, /127\.0\.0\.1:3000:3000/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /no-new-privileges:true/);
});
