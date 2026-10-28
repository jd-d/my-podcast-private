export interface AppEnv {
  DB: D1Database;
  AUDIO: R2Bucket;
  APP_HMAC_SECRET: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_OWNER_USER_ID?: string;
  PI_AGENT_TOKEN?: string;
  PUBLIC_BASE_URL?: string;
  PODCAST_TITLE?: string;
  PODCAST_DESCRIPTION?: string;
  PODCAST_AUTHOR?: string;
  PODCAST_IMAGE_URL?: string;
  DOWNLOAD_SESSION_MINUTES?: string;
}

export async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const aa = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  let difference = aa.length ^ bb.length;
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    difference |= (aa[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return difference === 0;
}

export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function isYoutubeUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    return ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(url.hostname);
  } catch {
    return false;
  }
}

export function publicOrigin(request: Request, env: AppEnv): string {
  const raw = env.PUBLIC_BASE_URL?.trim() || new URL(request.url).origin;
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1")
    throw new Error("PUBLIC_BASE_URL must be HTTPS");
  return url.origin;
}

async function replyKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const source = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({
    name: "HKDF", hash: "SHA-256", salt: encoder.encode("my-podcast-private"),
    info: encoder.encode("telegram-outbox-v1"),
  }, source, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function encryptReply(secret: string, updateId: number, text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({
    name: "AES-GCM", iv, additionalData: new TextEncoder().encode(`telegram:${updateId}`),
  }, await replyKey(secret), new TextEncoder().encode(text)));
  return JSON.stringify({ iv: Array.from(iv), data: btoa(String.fromCharCode(...encrypted)) });
}

export async function decryptReply(secret: string, updateId: number, serialized: string): Promise<string> {
  const value = JSON.parse(serialized) as { iv: number[]; data: string };
  const bytes = Uint8Array.from(atob(value.data), char => char.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({
    name: "AES-GCM", iv: new Uint8Array(value.iv),
    additionalData: new TextEncoder().encode(`telegram:${updateId}`),
  }, await replyKey(secret), bytes);
  return new TextDecoder().decode(plain);
}
