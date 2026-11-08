import { Context, Reader } from "@contentauth/c2pa-node";

export interface Credentials {
  status: "missing" | "present" | "invalid" | "unreadable";
  generated: boolean;
  store?: unknown;
}

export function credentialsFromStore(store: unknown, generators: readonly string[]): Credentials {
  if (store === null) return { status: "missing", generated: false };
  const data = store as { manifests?: Record<string, unknown>; active_manifest?: string; validation_state?: string; validation_status?: { success?: boolean }[] };
  const text = JSON.stringify(store);
  const generated = /trainedAlgorithmic(?:Media|Data)|compositeWithTrainedAlgorithmicMedia/i.test(text) ||
    generators.some((name) => name.trim() && text.toLowerCase().includes(name.trim().toLowerCase()));
  const hasFailure = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    return Object.entries(value).some(([key, child]) =>
      (key === "failure" && Array.isArray(child) && child.length > 0) || hasFailure(child));
  };
  const invalid = !data.manifests || !Object.keys(data.manifests).length ||
    (data.active_manifest !== undefined && !(data.active_manifest in data.manifests)) ||
    data.validation_state === "Invalid" || (data.validation_status?.some((status) => status.success !== true) ?? false) || hasFailure(store);
  return { status: invalid ? "invalid" : "present", generated };
}

export async function readCredentials(bytes: Buffer, mimeType: string, generators: readonly string[]): Promise<Credentials> {
  try {
    if (!bytes.length || bytes.length > 4 * 1024 * 1024 || !["image/jpeg", "image/png"].includes(mimeType)) {
      return { status: "unreadable", generated: false };
    }
    const reader = await Reader.fromAsset({ buffer: bytes, mimeType }, new Context({
      verify: { verifyAfterReading: true, remoteManifestFetch: false, ocspFetch: false },
    }));
    const store = reader?.json() ?? null;
    return { ...credentialsFromStore(store, generators), ...(store ? { store } : {}) };
  } catch {
    return { status: "unreadable", generated: false };
  }
}
