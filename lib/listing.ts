import { createHash } from "node:crypto";

export function listingHash(image: Uint8Array, title: string, price: string): string {
  return createHash("sha256").update(JSON.stringify([title, price, image.byteLength])).update(image).digest("hex");
}
