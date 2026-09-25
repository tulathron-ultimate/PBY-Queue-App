# PBY Queue on Unraid + Cloudflare Tunnel — step by step

This gets the queue app running on your Unraid server and reachable by guests' phones at a
short HTTPS address such as `https://q.photosbyyaz.com`, **without opening any ports on your
router**. Budget about 30–45 minutes the first time.

```
Guest phone ──HTTPS──► Cloudflare ──tunnel──► cloudflared container ──http──► pby-queue container :3000
                                               (on Unraid)                    (on Unraid, /data = appdata)
```

## 0. What you need

| Item | Notes |
|---|---|
| Unraid 6.12+ with Docker enabled | Settings → Docker → Enable Docker: Yes |
| A domain on Cloudflare | e.g. `photosbyyaz.com`. If the domain's DNS is elsewhere (Squarespace, GoDaddy…), either move DNS to Cloudflare (free plan) or buy a cheap short domain just for the queue. |
| A Cloudflare Zero Trust account | Free plan is fine (Zero Trust dashboard → pick the Free plan). |
| A short hostname | Keep it ≤ 25 characters (e.g. `q.photosbyyaz.com`) so texted links fit in one SMS. |

## 1. Build the image on Unraid

Open **Terminal** in the Unraid web UI (top right `>_` icon):

```bash
cd /mnt/user/appdata
git clone https://github.com/tulathron-ultimate/PBY-Queue-App.git pby-queue-src
cd pby-queue-src
docker build -t pby-queue:latest .

# Data folder, owned by the container's user (uid 1000)
mkdir -p /mnt/user/appdata/pby-queue
chown 1000:1000 /mnt/user/appdata/pby-queue
```

The build takes a few minutes. It needs `git`: if your Unraid doesn't have it, install
**NerdTools** or **Un-Get** from Community Apps, or download the repo ZIP from GitHub and
unzip it into `/mnt/user/appdata/pby-queue-src`.

Generate a strong admin password while you're in the terminal and save it in your password
manager:

```bash
openssl rand -base64 24
```

## 2. Add the pby-queue container

**Docker tab → Add Container**, switch to **Advanced View** (top right), and fill in:

| Field | Value |
|---|---|
| Name | `pby-queue` |
| Repository | `pby-queue:latest` |
| Network Type | `Bridge` |
| WebUI | `http://[IP]:[PORT:3000]/host` |
| Icon URL | *(optional)* |

Then use **Add another Path, Port, Variable…** for each row:

| Config type | Name | Container value | Host value / Value |
|---|---|---|---|
| Port | Web | `3000` | `3000` (any free port; see step 3 about exposure) |
| Path | Data | `/data` | `/mnt/user/appdata/pby-queue` |
| Variable | ADMIN_PASSWORD | — | *(the password from step 1; set Display: Masked)* |
| Variable | PUBLIC_URL | — | `https://q.photosbyyaz.com` |
| Variable | TRUST_PROXY | — | `1` |
| Variable | TZ | — | `America/Chicago` (your zone; affects log times only) |
| Variable | TWILIO_ACCOUNT_SID | — | *(leave blank until Twilio is verified)* |
| Variable | TWILIO_AUTH_TOKEN | — | *(blank for now; Masked)* |
| Variable | TWILIO_FROM | — | *(blank for now, later `+18885551234`)* |

Click **Apply**. The container should show **started** and, after ~30 s, **healthy**.

Quick check from the Unraid terminal:

```bash
curl -s http://localhost:3000/healthz     # → {"ok":true}
```

Or from your Windows PC in PowerShell (replace the IP with your Unraid server's):

```powershell
Invoke-RestMethod -Uri 'http://192.168.1.50:3000/healthz'   # → ok : True
```

## 3. Create the Cloudflare Tunnel

1. Cloudflare dashboard → **Zero Trust** → **Networks → Tunnels** → **Create a tunnel**.
2. Choose **Cloudflared**, name it `unraid`, **Save**.
3. On the install screen pick **Docker** and copy the long **token** from the command shown
   (the part after `--token`). You don't run that command yourself.
4. In Unraid: **Apps** (Community Apps) → search **cloudflared** → install the official-image
   template, paste the token into the **TUNNEL_TOKEN** field, Apply.
   *No template?* Docker → Add Container: Repository `cloudflare/cloudflared:latest`,
   Network `Bridge`, Post Arguments `tunnel --no-autoupdate run --token <TOKEN>`.
5. Back in Cloudflare the tunnel shows **Healthy**. Click **Next** / **Public Hostname** →
   **Add a public hostname**:

   | Field | Value |
   |---|---|
   | Subdomain | `q` |
   | Domain | `photosbyyaz.com` |
   | Path | *(blank)* |
   | Service type | `HTTP` |
   | URL | `<UNRAID_IP>:3000` (e.g. `192.168.1.50:3000`) |

   Save. WebSockets (live updates) work through tunnels automatically.

6. **Do not** port-forward 3000 on your router, and don't put the site behind Cloudflare
   Access: guests must reach `/j/…` (join) and `/s/…` (status) without logging in. If you
   want an extra login wall for hosts only, apply Access to the path `/host*`.

> **Why this matters:** with `TRUST_PROXY=1` the app trusts cloudflared to report the guest's
> real IP (used for rate limits). Anything that can reach port 3000 directly, bypassing the
> tunnel, could fake that. On a home LAN behind a router that is fine; just never forward the
> port to the internet.

## 4. First event (5-minute smoke test)

1. On your phone, open `https://q.photosbyyaz.com/host`.
2. **New event** → name `Test`, pick a 4–6 digit PIN, enter the **admin password**, texting
   mode **Tap to send**. Create.
3. **Add people** → **Excel / CSV** → pick `docs/samples/pby-sample-roster.xlsx` (or download
   the template from that screen). Review the preview, import.
4. Open the **QR / Share** screen, scan it with a second phone and self-join as a guest.
5. Tap **Check in** on a few parties, then **Call next** a few times. Watch the guest phone
   update live and the **Send texts** sheet open Messages with the text filled in.
6. When done: **Settings → End event → Delete now**.

On the phone you'll use at shoots: in Safari/Chrome, **Share → Add to Home Screen** so it
opens full-screen like an app.

## 5. Turning on Twilio later

Once toll-free verification is approved:

1. Edit the `pby-queue` container and fill `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`
   (masked) and `TWILIO_FROM` (`+1888…`). Apply (the container restarts; queue data is kept).
2. In the Twilio console → your number → **Messaging configuration** → *A message comes in*:
   **Webhook**, `https://q.photosbyyaz.com/sms/twilio/inbound`, **HTTP POST**. This is what
   handles STOP/START replies.
3. In the app, open an event's **Settings → Texting** and choose **Automatic (Twilio)**.

## 6. Updating to a new version

```bash
cd /mnt/user/appdata/pby-queue-src
git pull
docker build -t pby-queue:latest .
```

Then Docker tab → `pby-queue` → **Force Update** (or Stop/Start). Data in
`/mnt/user/appdata/pby-queue` is kept. Avoid updating during a live event.

## 7. Backups and privacy

Everything lives in `/mnt/user/appdata/pby-queue/pby-queue.db` (plus `-wal`/`-shm` files).
Guest names and numbers are purged automatically 7 days after an event closes. If the
**Appdata Backup** plugin backs this folder up, those backups keep guest data longer than 7
days: either exclude `pby-queue` from appdata backups or set a short backup retention. Export
the results CSV for photo ordering before the purge.

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| Container stops right after start, log says permission denied on `/data` | `chown 1000:1000 /mnt/user/appdata/pby-queue`, or add Extra Parameters `--user 99:100` and `chown 99:100` the folder. |
| "Creating events is disabled" | `ADMIN_PASSWORD` is empty or still the example placeholder. Set a real value and restart. |
| Guest page loads but never updates | Something between phone and app is blocking WebSockets: check that the Cloudflare hostname points at the tunnel (not a proxy/redirect rule), and that no browser extension/VPN interferes. |
| Tunnel shows **Down** | Check the cloudflared container log; re-paste the token; confirm Unraid has internet access. |
| Cloudflare error 502 | The public hostname URL is wrong (IP/port), or pby-queue isn't running. `curl http://<UNRAID_IP>:3000/healthz` from the Unraid terminal. |
| Logged-in host gets logged out on every refresh | You're using plain `http://` to the LAN IP. Use the `https://q.…` address (the session cookie is Secure over HTTPS). |
| Texted links are long / split into two SMS | Shorten the hostname in `PUBLIC_URL` (≤ 25 characters). |
| Twilio STOP replies not handled | Webhook URL must exactly match `PUBLIC_URL` + `/sms/twilio/inbound` (signature check uses it). |

Logs: Docker tab → click the `pby-queue` icon → **Logs**. Phone numbers are masked in logs.
