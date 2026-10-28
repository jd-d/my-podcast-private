# Raspberry Pi 3B+ agent setup

Final architecture uses **Raspberry Pi OS Lite 64-bit**, Python, systemd, yt-dlp and FFmpeg. No
Docker, GUI, port forwarding or public IP required.

## Requirements

- Stable power supply. On the user's Pi, previous undervoltage warnings make this a P0 check:
  `vcgencmd get_throttled` and test under load.
- 1 GB RAM Pi 3B+; **one job at a time** only.
- A current Debian/Raspberry Pi OS installation with Python 3.11+.
- Enough temporary disk space for downloaded audio plus any converted copy. `MAX_DOWNLOAD_MB`
  defaults to 300, so plan at least twice that free if transcoding.
- `yt-dlp` + `yt-dlp-ejs` + Deno >=2.3 (recommended) or Node >=22; see current [EJS
  guide](https://github.com/yt-dlp/yt-dlp/wiki/EJS). Debian apt's older Node may **not** satisfy the
  requirement.
- `ffmpeg`, `ffprobe`, CA certificates.

## Install packages

First inventory the intended Pi's existing services, OS, CPU architecture, storage
and power status. Installation does not authorize reimaging or replacing a workload.

This repository is private. On the authenticated development machine, export a
reviewed commit and transfer it using existing SSH access:

```bash
git archive --format=tar HEAD -o tmp/podcast-deploy.tar
scp tmp/podcast-deploy.tar <ssh-user>@<pi>:/tmp/podcast-deploy.tar
```

The archive contains tracked source only, without local secrets or private audio.
Do not copy broad GitHub credentials onto the Pi. A separately scoped read-only
deploy key is an alternative if a Git checkout is required.

On the Pi, adjust package commands to its actual OS release:

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip ffmpeg git ca-certificates
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin podcast || true
sudo install -d /opt/my-podcast-private
sudo tar -xf /tmp/podcast-deploy.tar -C /opt/my-podcast-private
sudo python3 -m venv /opt/my-podcast-private/.venv
sudo /opt/my-podcast-private/.venv/bin/pip install -U pip
sudo /opt/my-podcast-private/.venv/bin/pip install -r /opt/my-podcast-private/pi/requirements.txt "yt-dlp[default]"
```

Install an **ARM-compatible recent Deno**, ensuring the executable is in systemd's
PATH (for example `/usr/local/bin/deno`). Alternatively install Node >=22 and set
`YTDLP_JS_RUNTIME=node` in the agent env file. An absolute executable can be selected
as `YTDLP_JS_RUNTIME=node:/usr/local/bin/node`. The agent passes this explicitly,
even though yt-dlp configuration files are ignored. Startup checks the version.

Check as the unprivileged service user:

```bash
sudo -u podcast deno --version
/opt/my-podcast-private/.venv/bin/yt-dlp --version
sudo -u podcast /opt/my-podcast-private/.venv/bin/yt-dlp --js-runtimes deno -v --simulate 'https://www.youtube.com/watch?v=YOUR_OWN_TEST_VIDEO'
```

Do not commit source URLs or cookies. The test should confirm the JS runtime and EJS challenge
scripts work. If yt-dlp cannot find the runtime under systemd, use its absolute path in
`YTDLP_JS_RUNTIME`. Replace `deno` with `node` in the manual test for Node installs.

## Provision Pi-only credentials

Cloudflare account: create an **R2 bucket-scoped object access token** for
`my-podcast-private-audio`, with only the required object operations. Obtain its access-key ID and
secret. Avoid an account-wide admin token.

The Pi also needs `PI_AGENT_TOKEN`, an independently generated high-entropy token matching the
secret set on the Worker.

```bash
sudo install -d -m 0700 /etc/my-podcast-private
sudo cp /opt/my-podcast-private/pi/pi-agent.env.example /etc/my-podcast-private/pi-agent.env
sudo chmod 600 /etc/my-podcast-private/pi-agent.env
sudo chown root:root /etc/my-podcast-private/pi-agent.env
sudo nano /etc/my-podcast-private/pi-agent.env
```

The populated environment file must never enter Git.

## Install service

```bash
sudo cp /opt/my-podcast-private/pi/podcast-pi-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now podcast-pi-agent
sudo systemctl status podcast-pi-agent
journalctl -u podcast-pi-agent -f
```

The sample service runs as the unprivileged `podcast` user, is sandboxed with systemd and limits
memory/CPU. Confirm the Venv and binaries are readable by that user. Correct the path if the
checkout lives somewhere else.

## Operation and diagnostics

- No incoming ports are required; firewall SSH normally.
- The Pi polls once per 60 seconds by default.
- A job claim is good for 30 minutes; a heartbeat every 2 minutes extends it.
- A new job does not interrupt an existing one. A shared state-directory lock prevents a second
  agent process on the same Pi.
- A 401/403/409 heartbeat or local lease expiry stops processing. Temporary failures do not extend
  the local deadline.
- Each claim uses a fresh R2 upload prefix; obsolete attempts cannot overwrite published objects.
- The download size setting must be 1-2048 MiB. It also limits converted output. The agent reserves
  room for two copies plus 64 MiB before starting; conversion is monitored for oversized output.
- Use Telegram `/jobs` for status. Failure will be sent to your owner chat.
- If the Pi is powered off, jobs remain pending in Cloudflare D1 until it comes online.
- Reboot after setup to verify auto-start.
- If a worker dies mid-job, the lease eventually expires and the same job can be retried. Orphan R2
  objects may need cleanup.

## Security

No YouTube login cookies are installed by default. Do **not** copy your personal browser cookies to
the Pi without first evaluating the security and ToS implications. Use only media you are permitted
to obtain and share.

## Upgrade and rollback

Stop the service before applying database migrations or changing the upload
protocol. Preserve the previous reviewed source archive and environment file
privately. Apply all six D1 migrations and deploy the matching Worker before
starting this agent. The service now needs `StateDirectory=my-podcast-private`;
copy the updated unit and run daemon-reload on upgrades.

Do not roll back only the Worker or only the Pi across the attempt-upload change.
Test the previous pair against a restored scratch database first. Real power,
reboot, outage, ARM runtime and podcast-client tests remain required.
