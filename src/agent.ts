import type { AppEnv } from "./security";
import { constantTimeEqual, hmacHex } from "./security";
import { sendTelegram } from "./telegram";
import { readJsonObject, RequestError } from "./http";

type Job = { id: string; source_url: string; status: string; lease_digest: string | null; upload_prefix: string | null };
type Completion = {
  lease?: string;
  key?: string;
  title?: string;
  description?: string;
  mime_type?: string;
  duration_seconds?: number | null;
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex",
    "Referrer-Policy": "no-referrer",
  },
});

export async function agentApi(request: Request, env: AppEnv): Promise<Response> {
  if (!env.PI_AGENT_TOKEN || !env.APP_HMAC_SECRET) return json({ error: "Unconfigured" }, 503);
  const supplied = request.headers.get("Authorization") ?? "";
  if (!constantTimeEqual(supplied, `Bearer ${env.PI_AGENT_TOKEN}`)) return json({ error: "Unauthorized" }, 401);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let payload: Completion & { error?: string };
  try { payload = await readJsonObject(request, 20_000); }
  catch (error) {
    if (error instanceof RequestError) return json({ error: error.message }, error.status);
    throw error;
  }
  const path = new URL(request.url).pathname;

  if (path === "/agent/claim") {
    // One atomic SQL UPDATE claims the oldest pending or expired job.
    const lease = crypto.randomUUID() + "-" + crypto.randomUUID();
    const digest = await hmacHex(env.APP_HMAC_SECRET, `lease:${lease}`);
    const attempt = crypto.randomUUID();
    const job = await env.DB.prepare(
      `UPDATE import_jobs
       SET status='processing',lease_digest=?,lease_expires_at=datetime('now','+30 minutes'),
           attempts=attempts+1,updated_at=datetime('now'),upload_prefix='imports/' || id || '/' || ?
       WHERE id=(
         SELECT id FROM import_jobs
         WHERE status='pending' OR (status='processing' AND lease_expires_at <= datetime('now'))
         ORDER BY created_at ASC LIMIT 1
       )
       RETURNING id,source_url,upload_prefix`,
    ).bind(digest,attempt).first<{id:string;source_url:string;upload_prefix:string}>();
    return json({ job: job ? { id: job.id, url: job.source_url, lease, upload_prefix: job.upload_prefix } : null });
  }

  const match = /^\/agent\/jobs\/([a-f0-9-]{36})\/(heartbeat|complete|fail)$/.exec(path);
  if (!match) return json({ error: "Not found" }, 404);
  const [, id, operation] = match;
  if (typeof payload.lease !== "string" || !payload.lease || payload.lease.length > 120) return json({ error: "Invalid lease" }, 403);
  const digest = await hmacHex(env.APP_HMAC_SECRET, `lease:${payload.lease}`);

  const job = await env.DB.prepare(
    `SELECT id,source_url,status,lease_digest,upload_prefix FROM import_jobs
     WHERE id=? AND status='processing' AND lease_expires_at > datetime('now')`,
  ).bind(id).first<Job>();
  if (!job || !job.lease_digest || !constantTimeEqual(digest, job.lease_digest)) {
    return json({ error: "Expired or invalid lease" }, 409);
  }

  if (operation === "heartbeat") {
    const res = await env.DB.prepare(
      `UPDATE import_jobs SET lease_expires_at=datetime('now','+30 minutes'),
       updated_at=datetime('now')
       WHERE id=? AND status='processing' AND lease_digest=?
         AND lease_expires_at > datetime('now')`,
    ).bind(id,digest).run();
    return json({ ok: (res.meta.changes ?? 0) > 0 }, (res.meta.changes ?? 0) > 0 ? 200 : 409);
  }

  if (operation === "fail") {
    // Avoid echoing raw downloader stderr, which may contain private URLs or cookies.
    const error = typeof payload.error === "string"
      ? payload.error.replace(/https?:\/\/\S+/g, "[URL]").slice(0, 200)
      : "Import failed";
    const result = await env.DB.prepare(
      `UPDATE import_jobs SET status='failed',error_message=?,lease_digest=NULL,
       lease_expires_at=NULL,updated_at=datetime('now')
       WHERE id=? AND status='processing' AND lease_digest=?
         AND lease_expires_at > datetime('now')`,
    ).bind(error,id,digest).run();
    if ((result.meta.changes ?? 0) === 0) return json({ error: "Invalid lease" }, 409);
    await notifySafely(env, `Podcast import failed (${id}): ${error}`);
    return json({ ok: true });
  }

  const key = payload.key;
  const title = typeof payload.title === "string" ? payload.title.trim().slice(0, 240) : "";
  const desc = typeof payload.description === "string" ? payload.description.slice(0, 4000) : "";
  const mime = payload.mime_type;
  if (typeof key !== "string" || !job.upload_prefix ||
      ![`${job.upload_prefix}/audio.m4a`, `${job.upload_prefix}/audio.mp3`].includes(key)) {
    return json({ error: "Unsafe object key" }, 400);
  }
  if (!title || !["audio/mp4", "audio/mpeg"].includes(mime ?? "")) {
    return json({ error: "Bad metadata" }, 400);
  }
  if (mime === "audio/mp4" && !key.endsWith(".m4a")) return json({ error: "MIME mismatch" }, 400);
  if (mime === "audio/mpeg" && !key.endsWith(".mp3")) return json({ error: "MIME mismatch" }, 400);

  const object = await env.AUDIO.head(key);
  if (!object || object.size < 1) return json({ error: "Upload not found in R2" }, 400);
  const seconds = typeof payload.duration_seconds === "number" &&
    Number.isFinite(payload.duration_seconds) && payload.duration_seconds >= 0
    ? Math.round(payload.duration_seconds) : null;

  // All 3 steps are one D1 transaction. The conditional transition MUST win
  // before an episode can be inserted; the FK is linked only after insertion.
  let transitioned: number;
  try {
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE import_jobs
         SET status='completed',completed_at=datetime('now'),updated_at=datetime('now')
         WHERE id=? AND status='processing' AND lease_digest=?
           AND lease_expires_at > datetime('now')
         RETURNING id`,
      ).bind(id,digest),
      env.DB.prepare(
        `INSERT INTO episodes
           (id,title,description,r2_key,mime_type,byte_length,duration_seconds,published_at)
         SELECT ?,?,?,?,?,?,?,?
         FROM import_jobs WHERE id=? AND status='completed' AND lease_digest=?`,
      ).bind(id,title,desc,key,mime,object.size,seconds,new Date().toISOString(),id,digest),
      env.DB.prepare(
        `UPDATE import_jobs SET episode_id=?,lease_digest=NULL,lease_expires_at=NULL
         WHERE id=? AND status='completed' AND lease_digest=?`,
      ).bind(id,id,digest),
    ]);
    transitioned = results[0].results.length;
    if (transitioned !== 1 || (results[1].meta.changes ?? 0) !== 1
        || (results[2].meta.changes ?? 0) !== 1) {
      return json({ error: "Job no longer owns a valid lease" }, 409);
    }
  } catch {
    return json({ error: "Could not publish episode" }, 409);
  }
  await notifySafely(env, `Podcast episode published: ${title}\nJob: ${id}`);
  return json({ ok: true, episode_id: id, size: object.size });
}

async function notifySafely(env: AppEnv, message: string): Promise<void> {
  try { await sendTelegram(env, message); }
  catch { /* Notification failure must not break the job response. */ }
}
