import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions, Response as MFResponse } from "miniflare";
import { readFile, readdir, mkdir } from "node:fs/promises";
import { createHmac } from "node:crypto";

const token = "A".repeat(43);
const secret = "synthetic-integration-secret-never-deploy";
const base = "https://example.test";
const audio = `${base}/f/${token}/audio/episode`;
let mf, db, r2;
let sent = [], failSends = 0;

before(async () => {
  await mkdir("tmp", { recursive: true });
  await build({ entryPoints: ["src/index.ts"], bundle: true, format: "esm", outfile: "tmp/integration-worker.mjs" });
  const options = convertV4MiniflareOptions({
    modules: true, scriptPath: "tmp/integration-worker.mjs", compatibilityDate: "2026-10-07",
    d1Databases: ["DB","LEGACY"], r2Buckets: ["AUDIO"], log: new Log(LogLevel.ERROR),
    bindings: {
      APP_HMAC_SECRET: secret, PI_AGENT_TOKEN: "synthetic-agent", TELEGRAM_BOT_TOKEN: "synthetic-bot",
      TELEGRAM_WEBHOOK_SECRET: "synthetic-webhook", TELEGRAM_OWNER_USER_ID: "123456",
    },
    outboundService: async request => {
      const url = new URL(request.url);
      assert.equal(url.hostname, "api.telegram.org", "Only mocked Telegram calls are allowed");
      if (url.pathname.endsWith("/sendMessage")) {
        const payload = await request.json();
        sent.push(payload.text);
        if (failSends-- > 0) return new MFResponse('{"ok":false}', {status:503});
        return new MFResponse('{"ok":true}');
      }
      if (url.pathname.endsWith("/getFile")) return new MFResponse(JSON.stringify({ok:true,result:{file_path:"audio/synthetic.mp3",file_size:10}}));
      if (url.pathname.includes("/file/")) return new MFResponse(new Uint8Array(10), {headers:{"Content-Length":"10"}});
      throw new Error("Unexpected mocked request");
    },
  });
  options.telemetry = { enabled: false };
  mf = new Miniflare(options);
  db = await mf.getD1Database("DB");
  r2 = await mf.getR2Bucket("AUDIO");
  for (const file of (await readdir("migrations")).filter(f => f.endsWith(".sql")).sort()) {
    const sql = await readFile(`migrations/${file}`, "utf8");
    for (const statement of sql.split(";").map(s => s.replace(/--[^\n]*/g, "").trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
}, {timeout:30000});

beforeEach(async () => {
  sent = []; failSends = 0;
  await db.batch(["download_sessions", "recipient_episode_usage", "recipient_usage", "recipient_activity", "import_jobs", "episodes", "recipients", "telegram_updates"].map(table => db.prepare(`DELETE FROM ${table}`)));
  for (const object of (await r2.list()).objects) await r2.delete(object.key);
  const digest = createHmac("sha256",secret).update(`recipient:${token}`).digest("hex");
  await db.prepare("INSERT INTO recipients(id,alias,token_digest) VALUES (1,'Synthetic',?)").bind(digest).run();
  await r2.put("episode.mp3",new Uint8Array(10));
  await db.prepare("INSERT INTO episodes(id,title,r2_key,mime_type,byte_length,published_at) VALUES ('episode','Synthetic & audio','episode.mp3','audio/mpeg',10,'2026-10-28T00:00:00Z')").run();
});
after(async () => { await mf?.dispose(); });

async function get(headers = {}, method = "GET") {
  const response = await mf.dispatchFetch(audio, {method,headers:{"CF-Connecting-IP":"192.0.2.1","User-Agent":"synthetic",...headers}});
  const bytes = await response.arrayBuffer();
  return {status:response.status,headers:response.headers,length:bytes.byteLength};
}
async function count() {
  return (await db.prepare("SELECT COALESCE(SUM(download_count),0) AS n FROM recipient_episode_usage").first()).n;
}
async function telegram(id, message) {
  return mf.dispatchFetch(`${base}/telegram`, {method:"POST", headers:{"X-Telegram-Bot-Api-Secret-Token":"synthetic-webhook","Content-Type":"application/json"},body:JSON.stringify({update_id:id,message:{from:{id:123456},chat:{id:123456,type:"private"},...message}})});
}
async function api(path, payload) {
  const response = await mf.dispatchFetch(base+path,{method:"POST",headers:{Authorization:"Bearer synthetic-agent","Content-Type":"application/json"},body:JSON.stringify(payload)});
  return {status:response.status,body:await response.json()};
}

test("single and suffix ranges have exact lengths and finite Content-Range", async () => {
  for (const [range,expected,length] of [["bytes=0-3","bytes 0-3/10",4],["bytes=-3","bytes 7-9/10",3],["bytes=7-99","bytes 7-9/10",3],["bytes=2-","bytes 2-9/10",8]]) {
    const result = await get({Range:range});
    assert.equal(result.status,206); assert.equal(result.headers.get("Content-Range"),expected);
    assert.equal(result.headers.get("Content-Length"),String(length)); assert.equal(result.length,length);
  }
  assert.equal(await count(),1);
});

test("invalid and unsatisfiable ranges, HEAD and missing objects never charge quota", async () => {
  for (const range of ["bytes=999-","bytes=garbage","bytes=0-1,4-5","bytes=-0","bytes=9-1"]) {
    const r = await get({Range:range}); assert.equal(r.status,416); assert.equal(r.headers.get("Content-Range"),"bytes */10");
  }
  const head = await get({},"HEAD"); assert.equal(head.status,200); assert.equal(head.length,0);
  await r2.delete("episode.mp3"); assert.equal((await get()).status,404); assert.equal(await count(),0);
});

test("If-Range uses strong ETags and otherwise sends the complete representation", async () => {
  const head = await get({},"HEAD");
  assert.equal((await get({Range:"bytes=0-3","If-Range":head.headers.get("ETag")})).status,206);
  const full = await get({Range:"bytes=0-3","If-Range":"\"stale\""});
  assert.equal(full.status,200); assert.equal(full.length,10); assert.equal(full.headers.get("Content-Range"),null);
});

test("concurrent same-client ranges charge exactly once", async () => {
  const results = await Promise.all(Array.from({length:12},()=>get({Range:"bytes=0-3"})));
  assert.ok(results.every(r=>r.status===206)); assert.equal(await count(),1);
});

test("concurrent independent clients cannot exceed the cap; active sessions still resume", async () => {
  const results = await Promise.all(Array.from({length:12},(_,i)=>get({"User-Agent":`client-${i}`})));
  assert.equal(results.filter(r=>r.status===200).length,5);
  assert.equal(results.filter(r=>r.status===429).length,7); assert.equal(await count(),5);
  const winner = results.findIndex(r=>r.status===200);
  assert.equal((await get({"User-Agent":`client-${winner}`,Range:"bytes=4-"})).status,206);
});

test("sliding inactivity expiry is extended and expired sessions must recharge", async () => {
  await get();
  await db.prepare("UPDATE download_sessions SET expires_at=unixepoch()+1").run();
  assert.equal((await get()).status,200); assert.equal(await count(),1);
  const session = await db.prepare("SELECT expires_at-unixepoch() AS remaining FROM download_sessions").first();
  assert.ok(session.remaining>1700);
  await db.prepare("UPDATE download_sessions SET expires_at=unixepoch()-1").run();
  assert.equal((await get()).status,200); assert.equal(await count(),2);
});

test("recipient-wide accounting spans episodes without breaking existing sessions", async () => {
  await db.prepare("UPDATE recipients SET download_scope='recipient',download_limit=1").run();
  assert.equal((await get()).status,200);
  assert.equal((await get({"User-Agent":"second"})).status,429);
  assert.equal((await get({Range:"bytes=5-"})).status,206);
  await r2.put("second.mp3",new Uint8Array(10));
  await db.prepare("INSERT INTO episodes(id,title,r2_key,mime_type,byte_length,published_at) VALUES ('second','Second','second.mp3','audio/mpeg',10,'2026-10-28T00:00:00Z')").run();
  const second = await mf.dispatchFetch(`${base}/f/${token}/audio/second`,{headers:{"CF-Connecting-IP":"192.0.2.1","User-Agent":"synthetic"}});
  assert.equal(second.status,429);
  assert.equal((await db.prepare("SELECT download_count AS n FROM recipient_usage").first()).n,1);
});

test("a quota transaction failure cannot strand a charged or provisional session", async () => {
  await db.prepare("CREATE TRIGGER fail_charge BEFORE UPDATE ON recipient_episode_usage BEGIN SELECT RAISE(ABORT,'synthetic failure'); END").run();
  try {
    assert.equal((await get()).status,500);
    assert.equal(await count(),0);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM download_sessions").first()).n,0);
  } finally { await db.prepare("DROP TRIGGER fail_charge").run(); }
  assert.equal((await get()).status,200); assert.equal(await count(),1);
});

test("RSS escapes metadata and revoked or rotated tokens fail closed", async () => {
  const feed = await mf.dispatchFetch(`${base}/f/${token}/feed.xml`);
  assert.equal(feed.status,200); assert.match(await feed.text(),/Synthetic &amp; audio/);
  assert.equal(feed.headers.get("Cache-Control"),"private, no-store");
  await telegram(1,{text:"/rotate 1"});
  assert.equal((await get()).status,404);
  const replacement = sent[0].match(/https:\/\/[^\s]+\/feed.xml/)[0];
  assert.equal((await mf.dispatchFetch(replacement)).status,200);
  await telegram(2,{text:"/revoke 1"});
  assert.equal((await mf.dispatchFetch(replacement)).status,404);
});

test("Telegram rejects other users and groups even with a correct webhook secret", async () => {
  assert.equal((await telegram(1,{text:"/add Intruder",from:{id:999}})).status,200);
  assert.equal((await telegram(2,{text:"/add Intruder",chat:{id:123456,type:"group"}})).status,200);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM recipients").first()).n,1);
  assert.equal(sent.length,0);
});

test("lost Telegram reply is retried without repeating /add or exposing plaintext in D1", async () => {
  failSends=1;
  assert.equal((await telegram(5,{text:"/add New friend"})).status,503);
  const firstReply=sent[0];
  const pending=await db.prepare("SELECT reply_ciphertext FROM telegram_updates WHERE update_id=5").first();
  assert.ok(pending.reply_ciphertext); assert.ok(!pending.reply_ciphertext.includes("New friend"));
  assert.equal((await telegram(5,{text:"/add New friend"})).status,200);
  assert.equal(sent[1],firstReply);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM recipients").first()).n,2);
  const row=await db.prepare("SELECT * FROM telegram_updates WHERE update_id=5").first();
  assert.ok(row.reply_sent_at); assert.equal(row.reply_ciphertext,null); assert.ok(!JSON.stringify(row).includes("New friend"));
  assert.ok(!JSON.stringify(row).includes(firstReply.match(/\/f\/([^/]+)/)[1]));
  await telegram(5,{text:"/add New friend"}); assert.equal(sent.length,2);
});

test("lost /rotate reply reuses the committed token instead of rotating again", async () => {
  failSends=1;
  assert.equal((await telegram(6,{text:"/rotate 1"})).status,503);
  const digest=(await db.prepare("SELECT token_digest FROM recipients WHERE id=1").first()).token_digest;
  assert.equal((await telegram(6,{text:"/rotate 1"})).status,200);
  assert.equal(sent[0],sent[1]);
  assert.equal((await db.prepare("SELECT token_digest FROM recipients WHERE id=1").first()).token_digest,digest);
});

test("Telegram reset clears both usage and live session markers", async () => {
  await get(); await telegram(7,{text:"/reset 1"});
  assert.equal(await count(),0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM download_sessions").first()).n,0);
  await get(); assert.equal(await count(),1);
});

test("duplicate concurrent Telegram updates commit one operation", async () => {
  const results=await Promise.all(Array.from({length:4},()=>telegram(9,{text:"/add Concurrent"})));
  assert.ok(results.every(r=>r.status===200));
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM recipients WHERE alias='Concurrent'").first()).n,1);
});

test("a failed command transaction rolls back its outbox and retries safely", async () => {
  await db.prepare("CREATE TRIGGER fail_add BEFORE INSERT ON recipients WHEN NEW.alias='Retry' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END").run();
  try {
    assert.equal((await telegram(11,{text:"/add Retry"})).status,503);
    assert.equal(await db.prepare("SELECT * FROM telegram_updates WHERE update_id=11").first(),null);
  } finally { await db.prepare("DROP TRIGGER fail_add").run(); }
  assert.equal((await telegram(11,{text:"/add Retry"})).status,200);
});

test("direct Telegram audio upload publishes one episode across reply retries", async () => {
  failSends=1;
  const message={audio:{file_id:"synthetic",file_name:"synthetic.mp3",file_size:10,duration:4}};
  assert.equal((await telegram(15,message)).status,503);
  assert.equal((await telegram(15,message)).status,200);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM episodes WHERE r2_key LIKE 'telegram/%'").first()).n,1);
});

test("concurrent direct uploads keep the winning object and clean losing attempts", async () => {
  const message={audio:{file_id:"synthetic",file_name:"synthetic.mp3",file_size:10}};
  const responses=await Promise.all(Array.from({length:4},()=>telegram(16,message)));
  assert.ok(responses.every(r=>r.status===200));
  const episodes=await db.prepare("SELECT r2_key FROM episodes WHERE r2_key LIKE 'telegram/%'").all();
  assert.equal(episodes.results.length,1);
  assert.equal((await r2.head(episodes.results[0].r2_key)).size,10);
  assert.equal((await r2.list({prefix:"telegram/"})).objects.length,1);
});

test("job reclaim changes upload namespace and rejects stale completion", async () => {
  const id="00000000-0000-4000-8000-000000000001";
  await db.prepare("INSERT INTO import_jobs(id,source_url) VALUES (?,?)").bind(id,"https://youtu.be/synthetic").run();
  const first=(await api("/agent/claim",{})).body.job;
  assert.equal((await api(`/agent/jobs/${id}/heartbeat`,{lease:first.lease})).status,200);
  await db.prepare("UPDATE import_jobs SET lease_expires_at=datetime('now','-1 minute')").run();
  const second=(await api("/agent/claim",{})).body.job;
  assert.notEqual(first.upload_prefix,second.upload_prefix);
  const oldKey=`${first.upload_prefix}/audio.mp3`,newKey=`${second.upload_prefix}/audio.mp3`;
  await r2.put(oldKey,new Uint8Array(10)); await r2.put(newKey,new Uint8Array(12));
  const finish=(job,key)=>api(`/agent/jobs/${id}/complete`,{lease:job.lease,key,title:"Imported",mime_type:"audio/mpeg"});
  assert.equal((await finish(first,oldKey)).status,409);
  assert.equal((await finish(second,oldKey)).status,400);
  assert.equal((await finish(second,newKey)).status,200);
  await r2.put(oldKey,new Uint8Array(99));
  assert.equal((await r2.head(newKey)).size,12);
  assert.equal((await finish(second,newKey)).status,409);
  assert.equal((await api(`/agent/jobs/${id}/heartbeat`,{lease:second.lease})).status,409);
  assert.equal((await db.prepare("SELECT byte_length FROM episodes WHERE id=?").bind(id).first()).byte_length,12);
});

test("authenticated APIs reject malformed JSON and actual oversized bodies", async () => {
  for (const body of ["null","[]",'{"lease":123}']) {
    const response=await mf.dispatchFetch(`${base}/agent/jobs/00000000-0000-4000-8000-000000000001/heartbeat`,{method:"POST",headers:{Authorization:"Bearer synthetic-agent"},body});
    assert.ok([400,403].includes(response.status));
  }
  const response=await mf.dispatchFetch(`${base}/agent/claim`,{method:"POST",headers:{Authorization:"Bearer synthetic-agent"},body:JSON.stringify({padding:"x".repeat(21000)})});
  assert.equal(response.status,413);
  const stream = new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(JSON.stringify({padding:"x".repeat(21000)})));controller.close();}});
  const chunked = await mf.dispatchFetch(`${base}/agent/claim`,{method:"POST",headers:{Authorization:"Bearer synthetic-agent"},body:stream,duplex:"half"});
  assert.equal(chunked.status,413);
});

test("upgrade migrations preserve counters and charged legacy sessions", async () => {
  const legacy = await mf.getD1Database("LEGACY");
  async function apply(files) {
    for (const file of files) {
      const sql=await readFile(`migrations/${file}`,"utf8");
      for (const statement of sql.split(";").map(s=>s.replace(/--[^\n]*/g,"").trim()).filter(Boolean)) await legacy.prepare(statement).run();
    }
  }
  const files=(await readdir("migrations")).filter(f=>f.endsWith(".sql")).sort();
  await apply(files.slice(0,3));
  await legacy.batch([
    legacy.prepare("INSERT INTO recipients(id,alias,token_digest) VALUES (1,'Legacy','synthetic')"),
    legacy.prepare("INSERT INTO episodes(id,title,r2_key,byte_length,published_at) VALUES ('legacy','Legacy','legacy.mp3',10,'2026-10-28T00:00:00Z')"),
    legacy.prepare("INSERT INTO recipient_episode_usage VALUES (1,'legacy',3)"),
    legacy.prepare("INSERT INTO download_sessions(recipient_id,episode_id,client_digest,session_bucket,counted) VALUES (1,'legacy','charged',1,1),(1,'legacy','provisional',1,0)"),
    legacy.prepare("INSERT INTO telegram_updates(update_id) VALUES (77)"),
  ]);
  await apply(files.slice(3));
  assert.equal((await legacy.prepare("SELECT download_count FROM recipient_episode_usage").first()).download_count,3);
  const rows=await legacy.prepare("SELECT client_digest,expires_at FROM download_sessions").all();
  assert.equal(rows.results.length,1); assert.equal(rows.results[0].client_digest,"charged");
  assert.ok(rows.results[0].expires_at>Date.now()/1000);
  assert.equal((await legacy.prepare("SELECT reply_ciphertext FROM telegram_updates WHERE update_id=77").first()).reply_ciphertext,null);
});
