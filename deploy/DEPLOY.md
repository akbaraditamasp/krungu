# Deploy Krungu to Ubuntu (systemd + Caddy)

Layout: Caddy (80/443, automatic HTTPS) -> `127.0.0.1:4020` (`bun run src/server.ts`, systemd service `krungu`).
Everything lives in `/opt/krungu`, owned by the system user `krungu`.

## 0. Before you start
- **Commit and push first.** The repo has uncommitted work (mixer, rundown, trackmix, ...). A clone only gets what is pushed.
- The API has no authentication: the Caddyfile puts basic auth in front. Do not expose it without that.
- The audio path (YouTube search + yt-dlp + proxy) violates YouTube's terms and is for personal testing; datacenter IPs are often
  answered with 403 / "confirm you're not a bot". Bypassing that is out of scope. If it happens, run the server from a home connection.

## 1. Packages
```bash
sudo apt update
sudo apt install -y ffmpeg python3-venv git unzip curl nodejs      # nodejs: yt-dlp may need a JS runtime for YouTube
# Caddy (official repo)
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

## 2. User, code, runtime
```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin krungu
sudo mkdir -p /opt/krungu && sudo chown krungu:krungu /opt/krungu
sudo -u krungu bash -c 'curl -fsSL https://bun.sh/install | bash'                     # -> /home/krungu/.bun/bin/bun
sudo -u krungu git clone https://github.com/akbaraditamasp/krungu.git /opt/krungu     # private repo: use a deploy key / token
cd /opt/krungu
sudo -u krungu /home/krungu/.bun/bin/bun install --production
sudo -u krungu python3 -m venv .venv
sudo -u krungu .venv/bin/pip install -U yt-dlp                                        # keep it updated, YouTube changes often
```

## 3. Data that is not in git
From your PC (stop `bun run serve` first, or checkpoint the WAL so the .db is complete):
```bash
sqlite3 krungu.db "PRAGMA wal_checkpoint(TRUNCATE);"       # or just stop the server
scp krungu.db user@SERVER:/tmp/
# on the server:
sudo mv /tmp/krungu.db /opt/krungu/ && sudo chown krungu:krungu /opt/krungu/krungu.db
```
- `data/vocab.json` is in git and MUST match the database (it pins the LinUCB vocabulary; a different one resets all user profiles).
- `.env` (only needed for the pipeline jobs, e.g. `LASTFM_API_KEY=...`): create `/opt/krungu/.env`, `chmod 600`, owner `krungu`.
- Not needed on the server: `assets/`, `scripts/`, `out/`, `logs/`.

## 4. systemd
```bash
sudo cp deploy/krungu.service deploy/krungu-daily.service deploy/krungu-daily.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now krungu
sudo systemctl enable --now krungu-daily.timer       # nightly catalog growth, optional
systemctl status krungu;  journalctl -u krungu -f
curl -s localhost:4020/health                          # {"ok":true,"tracks":...}
```

## 5. Caddy
```bash
caddy hash-password                                    # paste the result into deploy/Caddyfile
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile          # edit the domain first
sudo systemctl reload caddy
sudo ufw allow 80,443/tcp                              # if ufw is on
```
Open `https://your-domain`: the browser asks for the basic-auth login, then the onboarding page loads.

## Update
```bash
cd /opt/krungu && sudo -u krungu git pull && sudo -u krungu /home/krungu/.bun/bin/bun install --production
sudo -u krungu .venv/bin/pip install -U yt-dlp
sudo systemctl restart krungu
```

## Notes
- The server is small (the catalog is loaded into memory: ~37k tracks). The web crossfade analysis downloads one song at a time (~4 MB,
  deleted afterwards) into `/opt/krungu/out/web-songs`.
- `bun run daily` and the server both write `krungu.db`; SQLite WAL mode allows that.
- Backups: copy `krungu.db` (after `PRAGMA wal_checkpoint(TRUNCATE)`); user profiles and events are in it.
