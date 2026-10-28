# Raspberry Pi 3B+ agent setup

Final architecture uses **Raspberry Pi OS Lite 64-bit**, Python, systemd, yt-dlp and FFmpeg. No Docker, GUI, port forwarding or public IP required.

## Requirements

- Stable power supply. On the user's Pi, previous undervoltage warnings make this a P0 check: `vcgencmd get_throttled` and test under load.
- 1 GB RAM Pi 3B+; **one job at a time** only.
- A current Debian/Raspberry Pi OS installation with Python 3.11+.
- Enough temporary disk space for downloaded audio plus any converted copy. `MAX_DOWNLOAD_MB` defaults to 300, so plan at least twice that free if transcoding.
- `yt-dlp` + `yt-dlp-ejs` + Deno >=2.3 (recommended) or Node >=22; see current [EJS guide](https://github.com/yt-dlp/yt-dlp/wiki/EJS). Debian apt's older Node may **not** satisfy the requirement.
- `ffmpeg`, `ffprobe`, CA certificates.

## Install packages

Example, adjust to actual Raspberry Pi OS release:

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip ffmpeg git ca-certificates
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin podcast || true
sudo git clone https://github.com/jd-d/my-podcast-private.git /opt/my-podcast-private
sudo python3 -m venv /opt/my-podcast-private/.venv
sudo /opt/my-podcast-private/.venv/bin/pip install -U pip
sudo /opt/my-podcast-private/.venv/bin/pip install -r /opt/my-podcast-private/pi/requirements.txt "yt-dlp[default]"
```

Install an **ARM-compatible recent Deno** following its official instructions, ensure the executable is in systemd's PATH (e.g. `/usr/local/bin/deno`). Check with:

```bash
deno --version
/opt/my-podcast-private/.venv/bin/yt-dlp --version
/opt/my-podcast-private/.venv/bin/yt-dlp -v --simulate 'https://www.youtube.com/watch?v=YOUR_OWN_TEST_VIDEO'
```

Do not commit source URLs or cookies. The test should confirm the JS runtime and EJS challenge scripts work. If yt-dlp cannot find Deno under systemd, update the service PATH or configure the runtime.

## Provision Pi-only credentials

Cloudflare account: create an **R2 bucket-scoped object access token** for `my-podcast-private-audio`, with only the required object operations. Obtain its access-key ID and secret. Avoid an account-wide admin token.

The Pi also needs `PI_AGENT_TOKEN`, an independently generated high-entropy token matching the secret set on the Worker.

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

The sample service runs as the unprivileged `podcast` user, is sandboxed with systemd and limits memory/CPU. Confirm the Venv and binaries are readable by that user. Correct the path if the checkout lives somewhere else.

## Operation and diagnostics

- No incoming ports are required; firewall SSH normally.
- The Pi polls once per 60 seconds by default.
- A job claim is good for 30 minutes; a heartbeat every 2 minutes extends it.
- A new job doesn't interrupt an existing one.
- Use Telegram `/jobs` for status. Failure will be sent to your owner chat.
- If the Pi is powered off, jobs remain pending in Cloudflare D1 until it comes online.
- Reboot after setup to verify auto-start.
- If a worker dies mid-job, the lease eventually expires and the same job can be retried. Orphan R2 objects may need cleanup.

## Security

No YouTube login cookies are installed by default. Do **not** copy your personal browser cookies to the Pi without first evaluating the security and ToS implications. Use only media you are permitted to obtain and share.
