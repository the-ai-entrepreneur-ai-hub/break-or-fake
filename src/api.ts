import type { ImageInput } from "../lib/app-types.js";

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function api<T>(path: string, options: {
  method?: "GET" | "POST"; body?: unknown; token?: string; signal?: AbortSignal;
} = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    headers: {
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000),
    cache: "no-store",
    referrerPolicy: "no-referrer",
  });
  let body: unknown;
  try { body = await response.json(); } catch { throw new ApiError("The service is unavailable. Please try again in a moment.", response.status); }
  if (!response.ok) {
    const error = body && typeof body === "object" ? body as { error?: unknown } : {};
    throw new ApiError(typeof error.error === "string" ? error.error : "This request could not be completed. Please try again.", response.status);
  }
  return body as T;
}

const tokenKey = (id: string) => `break-or-fake:access:${id}`;
export function rememberToken(token: string, ...ids: string[]): void {
  ids.forEach((id) => { try { sessionStorage.setItem(tokenKey(id), token); } catch { /* Session access still works in memory. */ } });
  ids.forEach((id) => tokens.set(id, token));
}
const tokens = new Map<string, string>();
export function buyerToken(id: string): string {
  if (tokens.has(id)) return tokens.get(id)!;
  try { return sessionStorage.getItem(tokenKey(id)) ?? ""; } catch { return ""; }
}

export function receiveCapability(id: string): string {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const token = fragment.get("token");
  if (token) {
    rememberToken(token, id);
    window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  }
  return buyerToken(id);
}

export async function originalImage(file: File): Promise<ImageInput> {
  if (file.type !== "image/jpeg" && file.type !== "image/png") throw new Error("Choose an original JPEG or PNG photo. HEIC files need to be exported as a supported original.");
  if (!file.size || file.size > 4 * 1024 * 1024) throw new Error("Choose an original photo no larger than 4 MB and 24 megapixels.");
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("This photo could not be read. Please choose it again."));
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.readAsDataURL(file);
  });
  return { mimeType: file.type, data };
}

export const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Something interrupted the request. Please try again.";
