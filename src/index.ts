import {
  escapeXml,
  formatRssDate,
  isValidBearerToken,
  parsePositiveInt,
  safeEpisodeId,
  secondsToItunesDuration,
  sessionBucket,
} from "./lib";

interface Env {
  DB: D1Database;
  AUDIO: R2Bucket;
  APP_HMAC_SECRET: string;
  PODCAST_TITLE?: string;
  PODCAST_DESCRIPTION?: string;
  PODCAST_AUTHOR?: string;
  PODCAST_IMAGE_URL?: string;
  DOWNLOAD_SESSION_MINUTES?: string;
}

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
      if (request.method !== "GET" && request.method !== "HEAD") {
        return response("Method Not Allowed", 405, { Allow: "GET, HEAD" });
      }

      const url = new URL(request.url);

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
        return serveFeed(request, env, recipient, token);
      }

      if (parts.length === 4 && parts[2] === "audio") {
        const episodeId = parts[3];
        if (!safeEpisodeId(episodeId)) {
          return response("Not Found", 404);
        }
        return serveAudio(request, env, recipient, episodeId, clientDigest);
      }

      return response("Not Found", 404);
    } catch (error) {
      console.error("Unhandled request error", error);
      return response("Internal Server Error", 500);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    // Download-session rows only exist to collapse Range retries into one
    // logical download. Retain a small window and discard stale rows.
    await env.DB.prepare(
      "DELETE FROM download_sessions WHERE created_at < datetime('now', '-14 days')",
    ).run();
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

  if (request.method === "HEAD") {
    const head = await env.AUDIO.head(episode.r2_key);
    if (!head) return response("Not Found", 404);

    await recordActivity(env.DB, recipient.id, "audio", clientDigest);
    return response("", 200, {
      "Content-Type": episode.mime_type,
      "Content-Length": String(episode.byte_length),
      "Accept-Ranges": "bytes",
      ETag: head.httpEtag,
    });
  }

  const decision = await registerDownloadSession(
    env.DB,
    recipient,
    episode.id,
    clientDigest,
    parsePositiveInt(env.DOWNLOAD_SESSION_MINUTES, 30),
  );

  if (!decision.allowed) {
    return response("Download limit reached", 429, {
      "Retry-After": "86400",
    });
  }

  await recordActivity(env.DB, recipient.id, "audio", clientDigest);

  const rangeHeader = request.headers.get("Range");
  const object = await env.AUDIO.get(
    episode.r2_key,
    rangeHeader ? { range: request.headers } : undefined,
  );

  if (!object) {
    return response("Not Found", 404);
  }

  const headers = new Headers(SECURITY_HEADERS);
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", episode.mime_type);
  headers.set("Accept-Ranges", "bytes");
  headers.set("ETag", object.httpEtag);

  let status = 200;
  if (rangeHeader && object.range) {
    status = 206;
    const offset = object.range.offset ?? 0;
    const length = object.range.length ?? episode.byte_length;
    const end = Math.min(offset + length - 1, episode.byte_length - 1);
    headers.set("Content-Range", `bytes ${offset}-${end}/${episode.byte_length}`);
    headers.set("Content-Length", String(Math.max(0, end - offset + 1)));
  } else {
    headers.set("Content-Length", String(episode.byte_length));
  }

  return new Response(object.body, { status, headers });
}

async function registerDownloadSession(
  db: D1Database,
  recipient: Recipient,
  episodeId: string,
  clientDigest: string,
  windowMinutes: number,
): Promise<{ allowed: boolean; counted: boolean; count?: number }> {
  const bucket = sessionBucket(Date.now(), windowMinutes);

  const inserted = await db.prepare(
    `INSERT OR IGNORE INTO download_sessions
       (recipient_id, episode_id, client_digest, session_bucket)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(recipient.id, episodeId, clientDigest, bucket)
    .run();

  if ((inserted.meta.changes ?? 0) === 0) {
    return { allowed: true, counted: false };
  }

  let updated: { download_count: number } | null;

  if (recipient.download_scope === "recipient") {
    await db.prepare(
      "INSERT OR IGNORE INTO recipient_usage (recipient_id, download_count) VALUES (?, 0)",
    )
      .bind(recipient.id)
      .run();

    updated = await db.prepare(
      `UPDATE recipient_usage
       SET download_count = download_count + 1
       WHERE recipient_id = ? AND download_count < ?
       RETURNING download_count`,
    )
      .bind(recipient.id, recipient.download_limit)
      .first<{ download_count: number }>();
  } else {
    await db.prepare(
      `INSERT OR IGNORE INTO recipient_episode_usage
         (recipient_id, episode_id, download_count)
       VALUES (?, ?, 0)`,
    )
      .bind(recipient.id, episodeId)
      .run();

    updated = await db.prepare(
      `UPDATE recipient_episode_usage
       SET download_count = download_count + 1
       WHERE recipient_id = ? AND episode_id = ? AND download_count < ?
       RETURNING download_count`,
    )
      .bind(recipient.id, episodeId, recipient.download_limit)
      .first<{ download_count: number }>();
  }

  if (!updated) {
    // Undo the dedupe marker so a later request still receives a clear denial.
    await db.prepare(
      `DELETE FROM download_sessions
       WHERE recipient_id = ? AND episode_id = ? AND client_digest = ? AND session_bucket = ?`,
    )
      .bind(recipient.id, episodeId, clientDigest, bucket)
      .run();

    return { allowed: false, counted: false };
  }

  return { allowed: true, counted: true, count: updated.download_count };
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
