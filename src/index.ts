import { parseByteRange } from "./http";
import { telegramWebhook } from "./telegram";
import { agentApi } from "./agent";
import type { AppEnv } from "./security";
import {
  escapeXml,
  formatRssDate,
  isValidBearerToken,
  parsePositiveInt,
  safeEpisodeId,
  secondsToItunesDuration,
} from "./lib";

interface Env extends AppEnv {}

interface Recipient {
  id: number;
  alias: string;
  status: "active" | "revoked";
  download_limit: number;
  download_scope: "episode" | "recipient";
}

interface Episode {
  id: string;
  title: string;
  description: string;
  r2_key: string;
  mime_type: string;
  byte_length: number;
  duration_seconds: number | null;
  published_at: string;
}

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Cache-Control": "private, no-store",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      // Keep administrative APIs separate from public podcast routes.
      if (url.pathname === "/telegram") {
        return await telegramWebhook(request, env);
      }
      if (url.pathname.startsWith("/agent/")) {
        return await agentApi(request, env);
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        return response("Method Not Allowed", 405, { Allow: "GET, HEAD" });
      }

      if (url.pathname === "/robots.txt") {
        return response("User-agent: *\nDisallow: /\n", 200, {
          "Content-Type": "text/plain; charset=utf-8",
        });
      }

      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length < 3 || parts[0] !== "f") {
        return response("Not Found", 404);
      }

      const token = parts[1];
      if (!isValidBearerToken(token)) {
        return response("Not Found", 404);
      }

      const recipient = await findRecipient(env, token);
      if (!recipient) {
        return response("Not Found", 404);
      }

      const clientDigest = await digestClient(request, env.APP_HMAC_SECRET, recipient.id);

      if (parts.length === 3 && parts[2] === "feed.xml") {
        if (request.method === "HEAD") {
          return response("", 200, { "Content-Type": "application/rss+xml; charset=utf-8" });
        }
        await recordActivity(env.DB, recipient.id, "feed", clientDigest);
        return await serveFeed(request, env, recipient, token);
      }

      if (parts.length === 4 && parts[2] === "audio") {
        const episodeId = parts[3];
        if (!safeEpisodeId(episodeId)) {
          return response("Not Found", 404);
        }
        return await serveAudio(request, env, recipient, episodeId, clientDigest);
      }

      return response("Not Found", 404);
    } catch {
      // Exception text and stacks may contain bearer URLs or upstream secrets.
      console.error("request_failed");
      return response("Internal Server Error", 500);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    // Download-session rows only exist to collapse Range retries into one
    // logical download. Retain a small window and discard stale rows.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM download_sessions WHERE expires_at <= unixepoch()"),
      env.DB.prepare("DELETE FROM telegram_updates WHERE processed_at < datetime('now', '-30 days')"),
    ]);
  },
} satisfies ExportedHandler<Env>;

async function findRecipient(env: Env, token: string): Promise<Recipient | null> {
  const digest = await hmacHex(env.APP_HMAC_SECRET, `recipient:${token}`);
  return env.DB.prepare(
    `SELECT id, alias, status, download_limit, download_scope
     FROM recipients
     WHERE token_digest = ? AND status = 'active'
     LIMIT 1`,
  )
    .bind(digest)
    .first<Recipient>();
}

async function serveFeed(
  request: Request,
  env: Env,
  _recipient: Recipient,
  token: string,
): Promise<Response> {
  const episodes = await env.DB.prepare(
    `SELECT id, title, description, r2_key, mime_type, byte_length,
            duration_seconds, published_at
     FROM episodes
     WHERE is_active = 1
     ORDER BY published_at DESC`,
  ).all<Episode>();

  const origin = new URL(request.url).origin;
  const title = env.PODCAST_TITLE ?? "Private audio";
  const description = env.PODCAST_DESCRIPTION ?? "Private audio feed";
  const author = env.PODCAST_AUTHOR ?? "Private";
  const image = env.PODCAST_IMAGE_URL?.trim();

  const items = episodes.results.map((episode) => {
    const audioUrl = `${origin}/f/${token}/audio/${encodeURIComponent(episode.id)}`;
    const duration = secondsToItunesDuration(episode.duration_seconds);

    return [
      "<item>",
      `<title>${escapeXml(episode.title)}</title>`,
      `<description>${escapeXml(episode.description)}</description>`,
      `<guid isPermaLink="false">${escapeXml(episode.id)}</guid>`,
      `<pubDate>${escapeXml(formatRssDate(episode.published_at))}</pubDate>`,
      `<enclosure url="${escapeXml(audioUrl)}" length="${episode.byte_length}" type="${escapeXml(episode.mime_type)}" />`,
      duration ? `<itunes:duration>${duration}</itunes:duration>` : "",
      "</item>",
    ]
      .filter(Boolean)
      .join("");
  });

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">',
    "<channel>",
    `<title>${escapeXml(title)}</title>`,
    `<description>${escapeXml(description)}</description>`,
    `<link>${escapeXml(origin)}</link>`,
    `<language>en</language>`,
    `<itunes:author>${escapeXml(author)}</itunes:author>`,
    "<itunes:block>Yes</itunes:block>",
    image ? `<itunes:image href="${escapeXml(image)}" />` : "",
    ...items,
    "</channel>",
    "</rss>",
  ]
    .filter(Boolean)
    .join("");

  return response(xml, 200, {
    "Content-Type": "application/rss+xml; charset=utf-8",
  });
}

async function serveAudio(
  request: Request,
  env: Env,
  recipient: Recipient,
  episodeId: string,
  clientDigest: string,
): Promise<Response> {
  const episode = await env.DB.prepare(
    `SELECT id, title, description, r2_key, mime_type, byte_length,
            duration_seconds, published_at
     FROM episodes
     WHERE id = ? AND is_active = 1
     LIMIT 1`,
  )
    .bind(episodeId)
    .first<Episode>();

  if (!episode) {
    return response("Not Found", 404);
  }

  const head = await env.AUDIO.head(episode.r2_key);
  if (!head) return response("Not Found", 404);
  if (request.method === "HEAD") {
    await recordActivity(env.DB, recipient.id, "audio", clientDigest);
    return response(null, 200, {
      "Content-Type": episode.mime_type,
      "Content-Length": String(head.size),
      "Accept-Ranges": "bytes",
      ETag: head.httpEtag,
    });
  }

  const requestedRange = request.headers.get("Range");
  const ifRange = request.headers.get("If-Range");
  // Only a matching strong ETag validates If-Range; dates/weak tags fall back
  // to a full response. Never assemble Content-Range from optional R2 getters.
  const useRange = requestedRange && (!ifRange || ifRange === head.httpEtag);
  const range = useRange ? parseByteRange(requestedRange, head.size) : undefined;
  if (range === null) {
    return response("Range Not Satisfiable", 416, { "Content-Range": `bytes */${head.size}` });
  }
  const object = await env.AUDIO.get(episode.r2_key, {
    ...(range ? { range } : {}),
    onlyIf: { etagMatches: head.etag },
  });
  if (!object) return response("Not Found", 404);
  if (!("body" in object)) return response("Object changed; retry", 503);

  try {
    await recordActivity(env.DB, recipient.id, "audio", clientDigest);
    const allowed = await registerDownloadSession(
      env.DB, recipient, episode.id, clientDigest,
      Math.min(parsePositiveInt(env.DOWNLOAD_SESSION_MINUTES, 30), 1440),
    );
    if (!allowed) {
      await object.body.cancel();
      return response("Download limit reached", 429);
    }
  } catch (error) {
    await object.body.cancel();
    throw error;
  }

  const headers = new Headers(SECURITY_HEADERS);
  headers.set("Content-Type", episode.mime_type);
  headers.set("Accept-Ranges", "bytes");
  headers.set("ETag", object.httpEtag);
  headers.set("Content-Length", String(range ? range.length : object.size));
  if (range) headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`);
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

async function registerDownloadSession(
  db: D1Database,
  recipient: Recipient,
  episodeId: string,
  clientDigest: string,
  windowMinutes: number,
): Promise<boolean> {
  const sessionId = crypto.randomUUID();
  const globalScope = recipient.download_scope === "recipient";
  // Table/column names are fixed application choices, never request input.
  const table = globalScope ? "recipient_usage" : "recipient_episode_usage";
  const usageKey = globalScope ? "recipient_id=?" : "recipient_id=? AND episode_id=?";
  const usageValues = globalScope ? [recipient.id] : [recipient.id, episodeId];
  const columns = globalScope ? "recipient_id" : "recipient_id,episode_id";
  const placeholders = globalScope ? "?" : "?,?";
  const sessionKey = "recipient_id=? AND episode_id=? AND client_digest=?";
  const key = [recipient.id, episodeId, clientDigest];

  // A single D1 batch is transactional. An attempt UUID identifies the one
  // insert that charges the counter; concurrent retries see its committed row.
  const results = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO ${table} (${columns},download_count) VALUES (${placeholders},0)`).bind(...usageValues),
    db.prepare(`DELETE FROM download_sessions WHERE ${sessionKey} AND expires_at <= unixepoch()`).bind(...key),
    db.prepare(`INSERT OR IGNORE INTO download_sessions
      (recipient_id,episode_id,client_digest,session_id,expires_at)
      SELECT ?,?,?,?,unixepoch()+? FROM ${table}
      WHERE ${usageKey} AND download_count < ?`)
      .bind(...key, sessionId, windowMinutes * 60, ...usageValues, recipient.download_limit),
    db.prepare(`UPDATE ${table} SET download_count=download_count+1
      WHERE ${usageKey} AND EXISTS (
        SELECT 1 FROM download_sessions WHERE ${sessionKey} AND session_id=?)`)
      .bind(...usageValues, ...key, sessionId),
    db.prepare(`UPDATE download_sessions SET expires_at=unixepoch()+?
      WHERE ${sessionKey} AND expires_at > unixepoch()`)
      .bind(windowMinutes * 60, ...key),
    db.prepare(`SELECT session_id FROM download_sessions
      WHERE ${sessionKey} AND expires_at > unixepoch()`).bind(...key),
  ]);
  return results[5].results.length === 1;
}

async function recordActivity(
  db: D1Database,
  recipientId: number,
  kind: "feed" | "audio",
  clientDigest: string,
): Promise<void> {
  const feedIncrement = kind === "feed" ? 1 : 0;
  const audioIncrement = kind === "audio" ? 1 : 0;
  const feedAt = kind === "feed" ? "datetime('now')" : "NULL";
  const audioAt = kind === "audio" ? "datetime('now')" : "NULL";

  await db.prepare(
    `INSERT INTO recipient_activity
       (recipient_id, feed_requests, audio_requests, last_feed_at, last_audio_at, last_client_digest)
     VALUES (?, ?, ?, ${feedAt}, ${audioAt}, ?)
     ON CONFLICT(recipient_id) DO UPDATE SET
       feed_requests = feed_requests + excluded.feed_requests,
       audio_requests = audio_requests + excluded.audio_requests,
       last_feed_at = CASE WHEN excluded.feed_requests > 0 THEN datetime('now') ELSE last_feed_at END,
       last_audio_at = CASE WHEN excluded.audio_requests > 0 THEN datetime('now') ELSE last_audio_at END,
       last_client_digest = excluded.last_client_digest`,
  )
    .bind(recipientId, feedIncrement, audioIncrement, clientDigest)
    .run();
}

async function digestClient(
  request: Request,
  secret: string,
  recipientId: number,
): Promise<string> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const ua = request.headers.get("User-Agent") ?? "unknown";
  return hmacHex(secret, `client:${recipientId}:${ip}\n${ua}`);
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function response(
  body: BodyInit | null,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: {
      ...SECURITY_HEADERS,
      ...extraHeaders,
    },
  });
}
