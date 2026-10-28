import type { AppEnv } from "./security";
import { constantTimeEqual, hmacHex, isYoutubeUrl, publicOrigin, randomToken } from "./security";

type TelegramMessage = {
  from?: { id: number };
  chat?: { id: number; type: string };
  text?: string;
  caption?: string;
  audio?: { file_id: string; file_size?: number; file_name?: string; title?: string; duration?: number; mime_type?: string };
  document?: { file_id: string; file_size?: number; file_name?: string; mime_type?: string };
};
type TelegramUpdate = { update_id?: number; message?: TelegramMessage };

export async function sendTelegram(env: AppEnv, text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_OWNER_USER_ID) return;
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_OWNER_USER_ID,
      text: text.slice(0, 4000),
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) throw new Error(`Telegram sendMessage returned HTTP ${res.status}`);
}

export async function telegramWebhook(request: Request, env: AppEnv): Promise<Response> {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  if (!env.TELEGRAM_WEBHOOK_SECRET || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_OWNER_USER_ID || !env.APP_HMAC_SECRET) {
    return new Response("Bot is not configured", { status: 503 });
  }
  const supplied = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!constantTimeEqual(supplied, env.TELEGRAM_WEBHOOK_SECRET)) return new Response("Not Found", { status: 404 });
  if (Number(request.headers.get("Content-Length") ?? "0") > 100_000) return new Response("Too large", { status: 413 });

  let update: TelegramUpdate;
  try { update = await request.json() as TelegramUpdate; }
  catch { return new Response("Bad request", { status: 400 }); }

  const message = update.message;
  const owner = env.TELEGRAM_OWNER_USER_ID;
  // Reject group commands and forwarded messages from everyone except the owner.
  if (String(message?.from?.id ?? "") !== owner ||
      String(message?.chat?.id ?? "") !== owner ||
      message?.chat?.type !== "private" || (!message?.text && !message?.audio && !message?.document)) {
    return new Response("OK");
  }

  if (typeof update.update_id !== "number" || !Number.isSafeInteger(update.update_id)) return new Response("Bad request", { status: 400 });
  const inserted = await env.DB.prepare(
    "INSERT OR IGNORE INTO telegram_updates (update_id) VALUES (?)",
  ).bind(update.update_id).run();
  if (inserted.meta.changes === 0) return new Response("OK");

  try {
    const reply = message.text
      ? await handleCommand(message.text, request, env)
      : await handleAudioUpload(message, env);
    await sendTelegram(env, reply);
  } catch {
    // Do not log message text, URLs or bearer tokens.
    await sendTelegram(env, "Command failed. Check Worker logs for a sanitized error and retry manually.");
  }
  return new Response("OK");
}

async function handleCommand(text: string, request: Request, env: AppEnv): Promise<string> {
  const trimmed = text.trim().slice(0, 2000);
  const [rawCommand, ...words] = trimmed.split(/\s+/);
  const cmd = rawCommand.toLowerCase().split("@")[0];
  const arg = words.join(" ").trim();

  if (cmd === "/start" || cmd === "/help") {
    return [
      "Private podcast admin",
      "/add <alias> : create a friend and private feed",
      "/list : friends, counters and status",
      "/revoke <id> : disable a feed immediately",
      "/rotate <id> : generate a replacement feed URL",
      "/limit <id> <1-100> : set per-episode cap",
      "/reset <id> : reset this friend's download counts",
      "/import <YouTube URL> : queue audio extraction on Pi",
      "Send MP3 or M4A under 20 MB to publish directly (no Pi).",
      "/jobs : latest import jobs",
      "/retry <job id> : retry failed import",
      "/help : this message",
      "Use this bot in a private chat only.",
    ].join("\n");
  }

  if (cmd === "/add") {
    if (!arg || arg.length > 100) return "Usage: /add <alias> (1 to 100 characters)";
    const token = randomToken();
    const digest = await hmacHex(env.APP_HMAC_SECRET, `recipient:${token}`);
    const result = await env.DB.prepare(
      "INSERT INTO recipients(alias,token_digest) VALUES (?,?) RETURNING id",
    ).bind(arg, digest).first<{ id: number }>();
    const origin = publicOrigin(request, env);
    return `Created #${result?.id} (${arg}). Private URL:\n${origin}/f/${token}/feed.xml\nSave it now. It cannot be recovered from D1. Telegram can retain this message.`;
  }

  if (cmd === "/list") {
    const rows = await env.DB.prepare(
      `SELECT r.id,r.alias,r.status,r.download_limit,
          COALESCE(a.feed_requests,0) AS feeds,
          COALESCE(a.audio_requests,0) AS audio,
          COALESCE((SELECT SUM(u.download_count) FROM recipient_episode_usage u WHERE u.recipient_id=r.id),0)
            + COALESCE((SELECT u.download_count FROM recipient_usage u WHERE u.recipient_id=r.id),0)
            AS downloads,
          a.last_audio_at
       FROM recipients r LEFT JOIN recipient_activity a ON a.recipient_id=r.id
       ORDER BY r.id DESC LIMIT 50`,
    ).all<{ id: number; alias: string; status: string; download_limit: number; feeds: number; audio: number; downloads: number; last_audio_at: string | null }>();
    if (!rows.results.length) return "No recipients yet. Use /add <alias>.";
    return rows.results.map(r => `#${r.id} ${r.alias} [${r.status}] cap=${r.download_limit}, feeds=${r.feeds}, audio requests=${r.audio}, last=${r.last_audio_at ?? "never"}`).join("\n").slice(0, 3900);
  }

  if (cmd === "/revoke" || cmd === "/rotate" || cmd === "/reset" || cmd === "/limit") {
    const id = Number(words[0]);
    if (!Number.isSafeInteger(id) || id <= 0) return `Usage: ${cmd} <numeric recipient id>`;
    const existing = await env.DB.prepare("SELECT id,alias,status FROM recipients WHERE id=?").bind(id).first<{id:number;alias:string;status:string}>();
    if (!existing) return "No such recipient.";
    if (cmd === "/revoke") {
      await env.DB.prepare("UPDATE recipients SET status='revoked', revoked_at=datetime('now') WHERE id=?").bind(id).run();
      return `Revoked #${id} (${existing.alias}).`;
    }
    if (cmd === "/rotate") {
      const token = randomToken();
      const digest = await hmacHex(env.APP_HMAC_SECRET, `recipient:${token}`);
      await env.DB.prepare("UPDATE recipients SET token_digest=?,status='active',revoked_at=NULL WHERE id=?").bind(digest,id).run();
      return `Rotated #${id} (${existing.alias}). Old link no longer works.\n${publicOrigin(request,env)}/f/${token}/feed.xml`;
    }
    if (cmd === "/reset") {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM recipient_episode_usage WHERE recipient_id=?").bind(id),
        env.DB.prepare("DELETE FROM recipient_usage WHERE recipient_id=?").bind(id),
        env.DB.prepare("DELETE FROM download_sessions WHERE recipient_id=?").bind(id),
      ]);
      return `Reset usage for #${id}.`;
    }
    const limit = Number(words[1]);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return "Usage: /limit <id> <1-100>";
    await env.DB.prepare("UPDATE recipients SET download_limit=? WHERE id=?").bind(limit,id).run();
    return `Cap for #${id} set to ${limit} per episode.`;
  }

  if (cmd === "/import") {
    if (!isYoutubeUrl(arg)) return "Usage: /import <https://youtube.com/... or https://youtu.be/...>";
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO import_jobs(id,source_url) VALUES (?,?)").bind(id,arg).run();
    return `Queued import: ${id}\nThe Pi will process it when online. /jobs shows progress.`;
  }

  if (cmd === "/jobs") {
    const rows = await env.DB.prepare(
      "SELECT id,status,attempts,created_at,error_message FROM import_jobs ORDER BY created_at DESC LIMIT 10",
    ).all<{id:string;status:string;attempts:number;created_at:string;error_message:string|null}>();
    return rows.results.length
      ? rows.results.map(r => `${r.id.slice(0,8)} ${r.status}, attempts=${r.attempts}${r.error_message ? ", error="+r.error_message.slice(0,100) : ""}`).join("\n")
      : "No imports yet.";
  }

  if (cmd === "/retry") {
    const id = words[0];
    if (!id || !/^[a-f0-9-]{36}$/i.test(id)) return "Usage: /retry <full job UUID>";
    const result = await env.DB.prepare(
      "UPDATE import_jobs SET status='pending',error_message=NULL,lease_digest=NULL,lease_expires_at=NULL,updated_at=datetime('now') WHERE id=? AND status='failed' RETURNING id",
    ).bind(id).first<{id:string}>();
    return result ? "Requeued failed job." : "No failed job with that ID.";
  }
  return "Unknown command. Use /help.";
}

async function handleAudioUpload(message: TelegramMessage, env: AppEnv): Promise<string> {
  const item = message.audio ?? message.document;
  if (!item) return "Send an MP3/M4A file or use /import <YouTube URL>.";
  const fileName = "file_name" in item ? (item.file_name ?? "") : "";
  const title: string = (("title" in item && typeof item.title === "string") ? item.title : fileName.replace(/\.(m4a|mp3)$/i, "")) || "Shared audio";
  const ext = fileName.toLowerCase().endsWith(".mp3") ? ".mp3"
    : fileName.toLowerCase().endsWith(".m4a") ? ".m4a"
    : item.mime_type === "audio/mpeg" ? ".mp3"
    : item.mime_type === "audio/mp4" || item.mime_type === "audio/x-m4a" ? ".m4a" : null;
  if (!ext) return "Only MP3 or AAC-in-M4A uploads are supported. For other formats, convert locally first.";
  const max = 20 * 1024 * 1024;
  if (typeof item.file_size === "number" && item.file_size > max) {
    return "Telegram Bot API cannot download files above 20 MB. Use the Pi importer or local upload tooling.";
  }

  // getFile is a private Telegram API call. Never log the bot token or resulting URL.
  const metaResponse = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(item.file_id)}`,
  );
  if (!metaResponse.ok) return "Telegram getFile failed.";
  const meta = await metaResponse.json() as {
    ok?: boolean; result?: { file_path?: string; file_size?: number };
  };
  const filePath = meta.result?.file_path;
  if (!meta.ok || !filePath || !/^[A-Za-z0-9._/-]+$/.test(filePath)
    || (meta.result?.file_size ?? max + 1) > max) {
    return "Telegram could not supply a supported file under 20 MB.";
  }

  const fileResponse = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`);
  if (!fileResponse.ok || !fileResponse.body) return "Telegram file download failed.";
  const contentLength = Number(fileResponse.headers.get("content-length") ?? meta.result?.file_size);
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0 || contentLength > max) {
    await fileResponse.body.cancel();
    return "Upload rejected: unknown or excessive size.";
  }
  const id = crypto.randomUUID();
  const mime = ext === ".mp3" ? "audio/mpeg" : "audio/mp4";
  const key = `telegram/${id}/audio${ext}`;
  const stored = await env.AUDIO.put(key, fileResponse.body, {
    httpMetadata: { contentType: mime },
  });
  if (!stored || stored.size <= 0) return "R2 upload failed.";

  const duration = "duration" in item && typeof item.duration === "number" ? item.duration : null;
  await env.DB.prepare(
    `INSERT INTO episodes(id,title,description,r2_key,mime_type,byte_length,duration_seconds,published_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).bind(id,title.slice(0,240),message.caption?.slice(0,1000) ?? "",
    key,mime,stored.size,duration,new Date().toISOString()).run();
  return `Published audio: ${title.slice(0,240)} (${(stored.size / 1048576).toFixed(2)} MB)`;
}
