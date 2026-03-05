# Nintendo TVii JP — Porting Guide

This document describes how to run the JP Nintendo TVii server locally and connect a real JP Wii U console.

---

## Required Environment Variables

Copy `.env.example` to `.env` and set at minimum:

| Variable | Description | JP Notes |
|---|---|---|
| `VINO_JP_CONFIG_ENV` | `dev` / `stg` / `prod` | Use `dev` for local work |
| `VINO_JP_TOKEN_SECRET` | XOR secret shared with Rosé Patcher | Must match your patcher build |
| `VINO_JP_CONFIG_DB_*` | MySQL connection | See Docker section below |
| `VINO_JP_XMLTV_ENABLED` | `true` to enable JP XMLTV EPG | **Required for JP** |
| `VINO_JP_XMLTV_PATH` | Path to `jp_merged_epg.xml.gz` | Absolute or relative to project root |
| `VINO_JP_XMLTV_LINEUP_PATH` | Path to `japan.json` (or `.md`) | Channel lineup mapping |
| `VINO_JP_XMLTV_TZ` | `Asia/Tokyo` (default) | JST timezone |
| `VINO_JP_XMLTV_REFRESH_MINUTES` | `30` (default) | How often to re-read the EPG file |
| `VINO_JP_XMLTV_ADULT_FILTER` | `true` (default) | Filter adult channels by keyword |

In `dev` mode, Discord webhook, Bluesky, MinIO, and TV listing URLs are **optional** (default to safe placeholders) — only MySQL, Redis, and the token secret are needed.

---

## Running the Server + Database

### 1. Start MySQL + Redis via Docker

```bash
docker compose up -d        # or: bun run db:up
```

This uses `docker-compose.yml` which:
- Starts MySQL 8.0 on port 3306 (root/root)
- Starts Redis 7 on port 6379
- Auto-runs `scripts/schema.sql` and `scripts/whitelist.sql` on first launch

### 2. (Re-)initialise DB manually (if needed)

```bash
bun run db:init
```

### 3. Add your PID to the whitelist

Connect to MySQL and insert your Pretendo PID:

```sql
USE whitelist;
INSERT INTO access_allowlist (pid, env) VALUES (<YOUR_PID>, 'dev');
```

### 4. Place the EPG file

Put `jp_merged_epg.xml.gz` in the `data/` folder at the project root (or wherever `VINO_JP_XMLTV_PATH` points).

### 5. Place the lineup mapping

Create `data/japan.json` — an array of objects:

```json
[
  { "channelId": "nhk-g.nhk.jp", "number": "1", "name": "NHK総合", "logo": null, "group": "地上波" },
  { "channelId": "nhk-e.nhk.jp", "number": "2", "name": "NHKEテレ", "logo": null, "group": "地上波" }
]
```

Or a Markdown table (`japan.md`):

```
| # | Channel ID | Name | Logo | Group |
|---|---|---|---|---|
| 1 | nhk-g.nhk.jp | NHK総合 | | 地上波 |
| 2 | nhk-e.nhk.jp | NHKEテレ | | 地上波 |
```

Only channels listed here are exposed to users. Adult-content channels are also keyword-filtered.

### 6. Start the dev server

```bash
bun run dev
```

Server runs on the port specified in `.env` (default 10060).

---

## Pointing a JP Wii U to Your Server

### DNS Method

1. Run a local DNS server (e.g. `dnsmasq`, `Technitium DNS`) that resolves the TVii hostname to your laptop's LAN IP.
2. On the Wii U, go to **System Settings → Internet → Connection Settings → DNS** and set it to your laptop's IP.
3. The Rosé Patcher plugin must be installed and its token secret must match `VINO_JP_TOKEN_SECRET`.

### Rosé Patcher

The Aroma plugin intercepts TVii requests and adds the `X-Nintendo-Service-Token` header containing: `pid, access_key, serial_part1, serial_part2, country, version` — XOR'd with the shared secret and base64-encoded.

---

## Common Failures

| Symptom | Likely Cause | Fix |
|---|---|---|
| **Error 119-1051** on Wii U | Token secret mismatch or plugin outdated | Verify `VINO_JP_TOKEN_SECRET` matches patcher; check `/debug/token` endpoint in dev mode |
| **"Not supported in your region"** | Country code not JP, or old client JS cached | Clear browser/Wii U cache; verify patcher sends `JP` country in token |
| **Blank provider list at setup** | XMLTV not enabled or EPG file missing | Set `VINO_JP_XMLTV_ENABLED=true`; check server logs for "XMLTV: failed to load" |
| **500 on account creation** | Database not running or tables missing | Run `bun run db:up && bun run db:init` |
| **"Unauthorized" / whitelist error** | PID not in whitelist DB | Insert your PID: `INSERT INTO whitelist.access_allowlist (pid, env) VALUES (<PID>, 'dev');` |
| **ipwho.is timeout on LAN** | LAN IPs return no timezone | JP accounts now auto-fallback to JST (utc_offset=32400) |

---

## API Endpoints (JP-specific)

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/providers/countries/JP/00000` | Returns XMLTV Japan provider |
| `GET /api/v1/providers/countries/JP/xmltv/channels` | Channel list from lineup mapping |
| `GET /api/v1/providers/lineup/JP/xmltv?start=...&duration=120` | Schedule in JST |
| `GET /api/v1/providers/info?country=JP&provider_id=xmltv&listingId=...` | Program details |
| `GET /debug/token` (dev only) | Parsed service-token diagnostics |
