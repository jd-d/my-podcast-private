#!/usr/bin/env python3
"""Outbound-polling Raspberry Pi downloader. No inbound ports, no Docker required.

Secrets are read from the process environment, normally systemd EnvironmentFile.
The Pi fetches one job, downloads only audio, uses FFmpeg only if required, and
uploads directly to a private R2 bucket with least-privilege S3 credentials.
"""
from __future__ import annotations

import json
import logging
import math
import os
import re
import signal
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
from botocore.config import Config

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


class LeaseLost(RuntimeError):
    pass


class LeaseGuard:
    """Never work beyond a locally known lease, including during an outage."""

    def __init__(self) -> None:
        self.lost = threading.Event()
        self.deadline = time.monotonic() + 1800 - 60

    def check(self, _bytes: int = 0) -> None:
        if self.lost.is_set() or time.monotonic() >= self.deadline:
            self.lost.set()
            raise LeaseLost("Job lease lost")

    def renew(self, started_at: float) -> None:
        # Request duration must not extend the server's actual lease locally.
        self.deadline = started_at + 1800 - 60


def execute(args: list[str], *, timeout: int, guard: LeaseGuard | None = None,
            output_limit: tuple[Path, int] | None = None) -> str:
    # No shell and no downloader stderr/URLs in diagnostics. Use a temporary
    # stdout file rather than retaining unbounded subprocess output in RAM.
    with tempfile.TemporaryFile(mode="w+t", encoding="utf-8") as output:
        process = subprocess.Popen(args, stdout=output, stderr=subprocess.DEVNULL,
                                   start_new_session=(os.name == "posix"))
        deadline = time.monotonic() + timeout
        try:
            while process.poll() is None:
                if guard:
                    guard.check()
                if time.monotonic() >= deadline:
                    raise RuntimeError("Tool timed out")
                if output_limit:
                    path, maximum = output_limit
                    if path.exists() and path.stat().st_size > maximum:
                        raise RuntimeError("Converted file exceeds configured size limit")
                time.sleep(0.2)
            if guard:
                guard.check()
            if process.returncode:
                raise RuntimeError(f"{Path(args[0]).name} failed (exit {process.returncode})")
            output.seek(0)
            return output.read(100_000).strip()
        except BaseException:
            if process.poll() is None:
                if os.name == "posix":
                    os.killpg(process.pid, signal.SIGTERM)
                else:
                    process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    if os.name == "posix":
                        os.killpg(process.pid, signal.SIGKILL)
                    else:
                        process.kill()
                    process.wait()
            raise


def downloader_binary() -> str:
    return os.getenv("YTDLP_BINARY", str(Path(sys.executable).with_name("yt-dlp")))


def js_runtime() -> tuple[str, str]:
    runtime = os.getenv("YTDLP_JS_RUNTIME", "deno")
    name, _, path = runtime.partition(":")
    if name not in {"deno", "node"}:
        raise RuntimeError("YTDLP_JS_RUNTIME must be deno or node, optionally :/absolute/path")
    return runtime, path or name


def check_tools() -> None:
    runtime, binary = js_runtime()
    for tool in (downloader_binary(), "ffmpeg", binary):
        if shutil.which(tool) is None:
            raise RuntimeError("Required executable not available")
    version = execute([binary, "--version"], timeout=10)
    match = re.search(r"(\d+)\.(\d+)\.(\d+)", version)
    if not match:
        raise RuntimeError("Cannot determine JavaScript runtime version")
    minimum = (2, 3, 0) if runtime.split(":", 1)[0] == "deno" else (22, 0, 0)
    if tuple(map(int, match.groups())) < minimum:
        raise RuntimeError("JavaScript runtime is too old")


def prepare_audio(source_url: str, directory: Path, max_mb: int, guard: LeaseGuard | None = None) -> tuple[Path, dict[str, Any]]:
    check_video_url(source_url)
    if max_mb < 1 or max_mb > 2048:
        raise RuntimeError("MAX_DOWNLOAD_MB must be between 1 and 2048")
    if shutil.disk_usage(directory).free < (2 * max_mb + 64) * 1024 * 1024:
        raise RuntimeError("Insufficient temporary disk space")
    runtime, _ = js_runtime()
    args = [
        downloader_binary(), "--ignore-config", "--no-playlist", "--no-progress",
        "--no-warnings", "--no-overwrites", "--write-info-json",
        "--js-runtimes", runtime,
        "--socket-timeout", "30", "--retries", "3", "--fragment-retries", "3",
        "--max-filesize", f"{max_mb}M", "-f", "ba[ext=m4a]/ba",
        "--paths", str(directory), "-o", "%(id)s.%(ext)s",
        "--print", "after_move:filepath", source_url,
    ]
    # Python-installed yt-dlp[default] supplies EJS; current Deno must be in PATH.
    stdout = execute(args, timeout=3600, guard=guard)
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
    ], timeout=3600, guard=guard, output_limit=(converted, max_mb * 1024 * 1024))
    if not converted.is_file() or converted.stat().st_size < 1:
        raise RuntimeError("FFmpeg produced no audio")
    if converted.stat().st_size > max_mb * 1024 * 1024:
        raise RuntimeError("Converted file exceeds configured size limit")
    return converted, metadata


def upload_to_r2(file: Path, upload_prefix: str, guard: LeaseGuard) -> tuple[str, str]:
    ext = file.suffix.lower()
    if ext not in {".mp3", ".m4a"}:
        raise RuntimeError("Unexpected audio extension")
    mime = "audio/mpeg" if ext == ".mp3" else "audio/mp4"
    guard.check()
    key = f"{upload_prefix}/audio{ext}"
    client = boto3.client(
        "s3",
        endpoint_url=f"https://{required('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com",
        aws_access_key_id=required("R2_ACCESS_KEY_ID"),
        aws_secret_access_key=required("R2_SECRET_ACCESS_KEY"),
        region_name="auto",
        config=Config(connect_timeout=10, read_timeout=30, retries={"max_attempts": 3}),
    )
    client.upload_file(
        str(file), required("R2_BUCKET"), key,
        ExtraArgs={"ContentType": mime},
        Callback=guard.check,
        Config=TransferConfig(max_concurrency=1, use_threads=False,
                              multipart_threshold=8 * 1024 * 1024,
                              multipart_chunksize=8 * 1024 * 1024),
    )
    guard.check()
    return key, mime


def keep_lease(stop: threading.Event, guard: LeaseGuard, api_base: str, token: str,
               job_id: str, lease: str) -> None:
    while not stop.wait(min(120, max(0, guard.deadline - time.monotonic()))):
        try:
            guard.check()
            started_at = time.monotonic()
            response = request_api(api_base, token, f"/agent/jobs/{job_id}/heartbeat", {"lease": lease})
            if not response.get("ok", False):
                guard.lost.set()
                return
            guard.renew(started_at)
        except urllib.error.HTTPError as exc:
            if exc.code in {401, 403, 409}:
                guard.lost.set()
                return
            LOG.warning("Heartbeat temporarily unavailable for job %s", job_id[:8])
        except LeaseLost:
            return
        except Exception:
            LOG.warning("Heartbeat temporarily unavailable for job %s", job_id[:8])


def process_job(job: dict[str, Any], api_base: str, token: str, max_mb: int) -> None:
    job_id, lease = job["id"], job["lease"]
    if not re.fullmatch(r"[a-f0-9-]{36}", job_id):
        raise RuntimeError("Unexpected job ID")
    check_video_url(job["url"])
    upload_prefix = job.get("upload_prefix", "")
    if not re.fullmatch(r"imports/" + re.escape(job_id) + r"/[a-f0-9-]{36}", upload_prefix):
        raise RuntimeError("Unexpected upload prefix")
    stop = threading.Event()
    guard = LeaseGuard()

    thread = threading.Thread(target=keep_lease, args=(stop, guard, api_base, token, job_id, lease), daemon=True)
    thread.start()
    stage = "download"
    try:
        with tempfile.TemporaryDirectory(prefix="podcast-import-") as workspace:
            directory = Path(workspace)
            LOG.info("Processing job %s", job_id[:8])
            audio, metadata = prepare_audio(job["url"], directory, max_mb, guard)
            guard.check()
            stage = "upload"
            key, mime = upload_to_r2(audio, upload_prefix, guard)
            guard.check()
            title = str(metadata.get("title") or "Imported audio")[:240]
            description = str(metadata.get("description") or "")[:4000]
            duration = metadata.get("duration")
            if isinstance(duration, bool) or not isinstance(duration, (float, int)) or not math.isfinite(duration) or duration < 0:
                duration = None
            stage = "publication"
            reply = request_api(api_base, token, f"/agent/jobs/{job_id}/complete", {
                "lease": lease, "key": key, "title": title,
                "description": description, "mime_type": mime,
                "duration_seconds": duration,
            })
            if not reply.get("ok"):
                raise RuntimeError("Worker declined completion")
            LOG.info("Published job %s as an episode (%s)", job_id[:8], mime)
    except Exception as exc:
        # Exceptions from S3, HTTP and tools may contain secrets or private
        # endpoints. Report only an application-owned category.
        error = "Lease lost" if isinstance(exc, LeaseLost) else f"Import failed during {stage}; inspect local configuration and retry"
        LOG.error("Job %s failed during %s (%s)", job_id[:8], stage, type(exc).__name__)
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
    if not 1 <= max_mb <= 2048:
        raise RuntimeError("MAX_DOWNLOAD_MB must be between 1 and 2048")
    # Fail fast if tools and S3 settings are missing.
    for name in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"):
        required(name)
    check_tools()
    # systemd StateDirectory provides a shared, writable lock outside PrivateTmp.
    import fcntl
    lock_path = Path(os.getenv("STATE_DIRECTORY", "/var/lib/my-podcast-private")) / "podcast-agent.lock"
    instance_lock = lock_path.open("a")
    try:
        fcntl.flock(instance_lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise RuntimeError("Another Pi agent is already running") from None
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
