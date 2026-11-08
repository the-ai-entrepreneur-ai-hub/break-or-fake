import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import sharp from "sharp";

const root = new URL("../", import.meta.url);
const assets = new URL(existsSync(new URL("public/assets/cup.jpg", root)) ? "public/assets/" : "dist/assets/", root);

for (const asset of [
  { id: "mug", bytes: 21908 },
  { id: "linen", bytes: 80044 },
  { id: "cup", bytes: 23761 },
]) {
  test(`${asset.id} synthetic catalog art keeps its JPEG format, dimensions, and size`, async () => {
    const bytes = await readFile(new URL(`${asset.id}.jpg`, assets));
    const metadata = await sharp(bytes).metadata();
    assert.equal(metadata.format, "jpeg");
    assert.equal(metadata.width, 1200);
    assert.equal(metadata.height, 800);
    assert.equal(bytes.length, asset.bytes);
  });
}
