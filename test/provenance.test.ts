import assert from "node:assert/strict";
import { test } from "node:test";
import { credentialsFromStore, readCredentials } from "../lib/provenance.js";

test("missing credentials mean unknown, not camera authenticity", () => {
  assert.deepEqual(credentialsFromStore(null, []), { status: "missing", generated: false });
});

test("generator declarations and digital source assertions hold evidence", () => {
  assert.equal(credentialsFromStore({ manifests: { current: { claim_generator_info: [{ name: "Test Image Editor" }] } } }, ["Test Image Editor"]).generated, true);
  assert.equal(credentialsFromStore({ manifests: { current: { assertions: [{ data: { actions: [{ digitalSourceType: "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia" }] } }] } } }, []).generated, true);
  assert.equal(credentialsFromStore({ manifests: { parent: { claim_generator: "Test Image Editor 1.0" } } }, ["Test Image Editor"]).generated, true);
});

test("invalid manifests never clear evidence", () => {
  assert.equal(credentialsFromStore({ manifests: {}, validation_status: [{ code: "assertion.dataHash.mismatch" }] }, []).status, "invalid");
  assert.equal(credentialsFromStore({ active_manifest: "missing", manifests: {} }, []).status, "invalid");
});

test("native reader handles an unsigned original PNG without network fetches", async () => {
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  assert.equal((await readCredentials(image, "image/png", [])).status, "missing");
});

test("malformed image data produces a hold rather than a clean bill", async () => {
  assert.equal((await readCredentials(Buffer.from("not an image"), "image/jpeg", [])).status, "unreadable");
});
