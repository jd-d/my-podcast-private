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
