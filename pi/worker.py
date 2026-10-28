#!/usr/bin/env python3
"""Outbound-polling Raspberry Pi downloader. No inbound ports, no Docker required.

Secrets are read from the process environment, normally systemd EnvironmentFile.
The Pi fetches one job, downloads only audio, uses FFmpeg only if required, and
uploads directly to a private R2 bucket with least-privilege S3 credentials.
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import sys
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import boto3
from boto3.s3.transfer import TransferConfig

LOG = logging.getLogger("podcast-pi-agent")
ALLOWED_HOSTS = frozenset({
    "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"
})


def required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment setting: {name}")
    return value


def check_video_url(value: str) -> None:
    parsed = urlparse(value)
    if parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS or parsed.username or parsed.password or parsed.port:
        raise ValueError("Only HTTPS YouTube URLs are permitted")


def request_api(api_base: str, token: str, path: str, payload: dict[str, Any]) -> dict[str, Any]:
    url = api_base.rstrip("/") + path
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST", headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "User-Agent": "my-podcast-private-pi-agent/0.2",
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.load(resp)
        if not isinstance(result, dict):
            raise RuntimeError("Unexpected API reply")
        return result


def execute(args: list[str], *, timeout: int) -> str:
    # subprocess.run avoids shell injection. Logs never include raw source URLs.
    result = subprocess.run(
        args, check=False, capture_output=True, text=True,
        timeout=timeout, encoding="utf-8", errors="replace",
    )
    if result.returncode:
        raise RuntimeError(f"{Path(args[0]).name} failed (exit {result.returncode})")
    return result.stdout.strip()


def prepare_audio(source_url: str, directory: Path, max_mb: int) -> tuple[Path, dict[str, Any]]:
    check_video_url(source_url)
    yt_dlp = os.getenv("YTDLP_BINARY", str(Path(sys.executable).with_name("yt-dlp")))
    args = [
        yt_dlp, "--ignore-config", "--no-playlist", "--no-progress",
        "--no-warnings", "--no-overwrites", "--write-info-json",
        "--socket-timeout", "30", "--retries", "3", "--fragment-retries", "3",
        "--max-filesize", f"{max_mb}M", "-f", "ba[ext=m4a]/ba",
        "--paths", str(directory), "-o", "%(id)s.%(ext)s",
        "--print", "after_move:filepath", source_url,
    ]
    # Python-installed yt-dlp[default] supplies EJS; current Deno must be in PATH.
    stdout = execute(args, timeout=3600)
    candidates = [Path(line) for line in stdout.splitlines() if line.strip()]
    audio = next((p for p in reversed(candidates) if p.is_file()), None)
    if audio is None or audio.parent.resolve() != directory.resolve():
        raise RuntimeError("Downloader did not produce a safe audio file")
    if audio.stat().st_size > max_mb * 1024 * 1024:
        raise RuntimeError("Downloaded file exceeds configured size limit")
    info_files = list(directory.glob("*.info.json"))
    metadata: dict[str, Any] = {}
    if info_files:
        with info_files[0].open(encoding="utf-8") as handle:
            metadata = json.load(handle)

    if audio.suffix.lower() in {".m4a", ".mp3"}:
        return audio, metadata

    converted = directory / "audio.m4a"
    execute([
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(audio), "-vn", "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart", str(converted),
    ], timeout=3600)
    if not converted.is_file() or converted.stat().st_size < 1:
        raise RuntimeError("FFmpeg produced no audio")
    return converted, metadata


def upload_to_r2(file: Path, job_id: str) -> tuple[str, str]:
    ext = file.suffix.lower()
    if ext not in {".mp3", ".m4a"}:
        raise RuntimeError("Unexpected audio extension")
    mime = "audio/mpeg" if ext == ".mp3" else "audio/mp4"
    key = f"imports/{job_id}/audio{ext}"
    client = boto3.client(
        "s3",
        endpoint_url=f"https://{required('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com",
        aws_access_key_id=required("R2_ACCESS_KEY_ID"),
        aws_secret_access_key=required("R2_SECRET_ACCESS_KEY"),
        region_name="auto",
    )
    client.upload_file(
        str(file), required("R2_BUCKET"), key,
        ExtraArgs={"ContentType": mime},
        Config=TransferConfig(max_concurrency=1, use_threads=False,
                              multipart_threshold=8 * 1024 * 1024,
                              multipart_chunksize=8 * 1024 * 1024),
    )
    return key, mime


def process_job(job: dict[str, Any], api_base: str, token: str, max_mb: int) -> None:
    job_id, lease = job["id"], job["lease"]
    if not re.fullmatch(r"[a-f0-9-]{36}", job_id):
        raise RuntimeError("Unexpected job ID")
    check_video_url(job["url"])
    stop = threading.Event()
    lost_lease = threading.Event()

    def heartbeat() -> None:
        while not stop.wait(120):
            try:
                response = request_api(api_base, token, f"/agent/jobs/{job_id}/heartbeat", {"lease": lease})
                if not response.get("ok", False):
                    lost_lease.set()
                    return
            except Exception:
                LOG.warning("Heartbeat failed for job %s", job_id[:8])

    thread = threading.Thread(target=heartbeat, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="podcast-import-") as workspace:
            directory = Path(workspace)
            LOG.info("Processing job %s", job_id[:8])
            audio, metadata = prepare_audio(job["url"], directory, max_mb)
            if lost_lease.is_set():
                raise RuntimeError("Job lease was lost before upload")
            key, mime = upload_to_r2(audio, job_id)
            if lost_lease.is_set():
                raise RuntimeError("Job lease was lost after upload")
            title = str(metadata.get("title") or "Imported audio")[:240]
            description = str(metadata.get("description") or "")[:4000]
            duration = metadata.get("duration")
            if not isinstance(duration, (float, int)) or duration < 0:
                duration = None
            reply = request_api(api_base, token, f"/agent/jobs/{job_id}/complete", {
                "lease": lease, "key": key, "title": title,
                "description": description, "mime_type": mime,
                "duration_seconds": duration,
            })
            if not reply.get("ok"):
                raise RuntimeError("Worker declined completion")
            LOG.info("Published job %s as an episode (%s)", job_id[:8], mime)
    except Exception as exc:
        error = str(exc)
        error = re.sub(r"https?://\S+", "[URL]", error)[:180]
        LOG.error("Job %s failed: %s", job_id[:8], error)
        try:
            request_api(api_base, token, f"/agent/jobs/{job_id}/fail", {
                "lease": lease, "error": error
            })
        except Exception:
            LOG.error("Could not report job failure; lease will eventually expire")
    finally:
        stop.set()
        thread.join(timeout=5)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    api_base = required("PODCAST_WORKER_URL").rstrip("/")
    if urlparse(api_base).scheme != "https":
        raise RuntimeError("PODCAST_WORKER_URL must be HTTPS")
    token = required("PI_AGENT_TOKEN")
    max_mb = int(os.getenv("MAX_DOWNLOAD_MB", "300"))
    interval = max(10, int(os.getenv("POLL_INTERVAL_SECONDS", "60")))
    # Fail fast if tools and S3 settings are missing.
    for name in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"):
        required(name)
    for tool in (os.getenv("YTDLP_BINARY", "yt-dlp"), "ffmpeg"):
        if shutil.which(tool) is None:
            raise RuntimeError(f"Required executable not available: {tool}")
    while True:
        try:
            result = request_api(api_base, token, "/agent/claim", {})
            job = result.get("job")
            if isinstance(job, dict):
                process_job(job, api_base, token, max_mb)
                continue
        except urllib.error.HTTPError as exc:
            LOG.error("Agent API returned HTTP %s", exc.code)
        except Exception as exc:
            LOG.error("Worker polling error: %s", type(exc).__name__)
        time.sleep(interval)


if __name__ == "__main__":
    main()
