import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { z } from "zod";
import { MAX_FRAME_BYTES } from "./capture.js";

const metadataSchema = z.object({
  mode: z.literal("spike"),
  session: z.object({
    id: z.string().uuid(), orderId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    nonce: z.string().regex(/^[a-f0-9]{64}$/), code: z.string().regex(/^\d{3}$/),
    issuedAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative(),
  }),
  receivedAt: z.number().int().nonnegative(),
  frames: z.array(z.object({
    name: z.string().regex(/^frame-[123]\.(jpg|png)$/),
    mimeType: z.enum(["image/jpeg", "image/png"]), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })).length(3),
});

export async function loadCapture(root: string, id: string) {
  if (!z.string().uuid().safeParse(id).success) throw new Error("invalid capture id");
  const base = await realpath(root);
  const directory = await realpath(resolve(base, id));
  if (!directory.startsWith(`${base}${sep}`)) throw new Error("capture outside local directory");
  const metadataPath = await realpath(resolve(directory, "capture.json"));
  if (!metadataPath.startsWith(`${directory}${sep}`)) throw new Error("metadata outside capture directory");
  const metadata = metadataSchema.parse(JSON.parse(await readFile(metadataPath, "utf8")));
  if (metadata.session.id !== id || metadata.session.expiresAt - metadata.session.issuedAt !== 120000 ||
      metadata.receivedAt < metadata.session.issuedAt || metadata.receivedAt >= metadata.session.expiresAt) throw new Error("expired or invalid session metadata");
  if (new Set(metadata.frames.map((frame) => frame.name)).size !== 3 ||
      new Set(metadata.frames.map((frame) => frame.sha256)).size !== 3) throw new Error("duplicate saved frames");
  const images = await Promise.all(metadata.frames.map(async (frame, index) => {
    if (frame.name !== `frame-${index + 1}.${frame.mimeType === "image/png" ? "png" : "jpg"}`) throw new Error("invalid frame order");
    const path = await realpath(resolve(directory, frame.name));
    if (!path.startsWith(`${directory}${sep}`)) throw new Error("frame outside capture directory");
    const bytes = await readFile(path);
    if (!bytes.length || bytes.length > MAX_FRAME_BYTES) throw new Error("invalid saved frame size");
    if (createHash("sha256").update(bytes).digest("hex") !== frame.sha256) throw new Error("saved frame hash mismatch");
    return { bytes, mediaType: frame.mimeType };
  }));
  return { metadata, images };
}
