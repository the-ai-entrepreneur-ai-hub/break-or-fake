import { createHash } from "node:crypto";
import sharp from "sharp";
import type { ImageInput } from "./app-types.js";
import { AppError } from "./app-security.js";

export async function validateImage(input: ImageInput): Promise<{ bytes: Buffer; mimeType: ImageInput["mimeType"]; sha256: string }> {
  const bad = () => new AppError(400, "Use an original JPEG or PNG image, up to 4 MB and 24 megapixels.");
  if (!input || !["image/jpeg", "image/png"].includes(input.mimeType) || typeof input.data !== "string" ||
      input.data.length > Math.ceil(4 * 1024 * 1024 / 3) * 4 || input.data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(input.data)) throw bad();
  const bytes = Buffer.from(input.data, "base64");
  if (!bytes.length || bytes.length > 4 * 1024 * 1024 || bytes.toString("base64") !== input.data) throw bad();
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if ((input.mimeType === "image/png" && !png) || (input.mimeType === "image/jpeg" && !jpeg)) throw bad();
  try {
    const metadata = await sharp(bytes, { limitInputPixels: 24_000_000 }).metadata();
    if (!metadata.width || !metadata.height || metadata.width < 32 || metadata.height < 32 ||
        metadata.width * metadata.height > 24_000_000 || (metadata.pages ?? 1) > 1) throw bad();
  } catch { throw bad(); }
  return { bytes, mimeType: input.mimeType, sha256: createHash("sha256").update(bytes).digest("hex") };
}
