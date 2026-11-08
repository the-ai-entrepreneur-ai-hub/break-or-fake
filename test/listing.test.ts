import assert from "node:assert/strict";
import { test } from "node:test";
import { listingHash } from "../lib/listing.js";

test("listing binding changes with image bytes, title and price", () => {
  const bytes = Buffer.from("original image");
  const hash = listingHash(bytes, "Mug", "32.00");
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(hash, listingHash(bytes, "Mug", "32.00"));
  assert.notEqual(hash, listingHash(Buffer.from("different image"), "Mug", "32.00"));
  assert.notEqual(hash, listingHash(bytes, "Cup", "32.00"));
  assert.notEqual(hash, listingHash(bytes, "Mug", "12.00"));
});
