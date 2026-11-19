# 👻 GHOST HOST — free Railway deployments from a shared token pool

GHOST HOST is a Railway-style hosting panel with a dark, 3D-accented front end.

- **Free for everyone:** any visitor can deploy a ZIP or a GitHub repo **without a token and without an
  account**. The owner loads Railway tokens into a pool; each build reserves one free slot on the
  healthiest token.
- **Owner console:** token pool (capacity + priority per token), who deployed what, every build's logs,
  Railway projects and MongoDB failover — unlocked with the owner password set in `.env`.
- **MongoDB failover:** add as many MongoDB connection URLs as you want (env or owner console). If one
  stops working, GHOST HOST automatically switches to the next one. If none work, it keeps running on a
  local JSON snapshot.
- **24/7:** every deploy is set to Railway's **ALWAYS** restart policy automatically, and a start command
  is detected when there is no Dockerfile.

![stack](https://img.shields.io/badge/node-%3E%3D20-brightgreen) ![railway](https://img.shields.io/badge/powered%20by-Railway-9d6bff)

---

## 1. Requirements

| Thing | Why |
|---|---|
| Node.js 20+ | Runs the panel (Node 22/24 recommended) |
| Railway account | Tokens + hosting for deployed bots |
| Railway **Account token** | Created at `railway.com/account/tokens` (choose "No workspace") |

> The panel bundles the Railway CLI (`@railway/cli`) as an npm dependency, so `railway up` works out of the box.

---

## 2. Run it (local)

```bash
cd sakurahost
npm install
cp .env.example .env      # Windows: copy .env.example .env
npm start
```

Open **http://localhost:3000**.

### Run 24/7 with your PC off (free)

The panel itself only runs while this machine is on. To keep it online without the PC:
**Render Free + MongoDB Atlas Free + cron-job.org keep-alive** — full step-by-step guide in
[`DEPLOY-24-7.md`](DEPLOY-24-7.md). Deployed apps are already 24/7 on Railway regardless.

### First clicks

1. **Owner console** (top right) → owner password from `.env` → **Token pool** → add a Railway token.
2. Anyone can now use the hero card: enter a name, drop a `.zip` (or paste a GitHub repo), deploy.
3. Watch the live terminal; the public URL appears when the build is green. Owner sees every build under
   **Users** and **Deployments**.

The owner password lives only in `.env` (or host env vars). It is never displayed anywhere in the UI.

---

## 3. Create a Railway token

1. Open <https://railway.com/account/tokens>.
2. Click **Create token**.
3. Name it e.g. `ghosthost`.
4. Workspace → **No workspace** (account token — needed to create new projects).
5. Copy the token.

> Project tokens won't work for creating new projects. Account or Workspace tokens do.

---

## 4. Deploy a bot

### Free deploy (no login, no token)

1. Zip your app folder (`main.py`, `requirements.txt`, `package.json`, … at the root or inside one top folder).
2. Enter your name, drop the ZIP, name the project, deploy.
3. A free slot is taken from the pool for your build; the token itself is never sent to the browser.

GitHub deploys work the same way (**GitHub repo** tab): public repos build instantly.

Limits (defaults): 8 deploys per hour per visitor/IP, 2 active builds per visitor, 2 builds at a time
(total), all configurable with env vars.

### Owner console (token pool)

1. **Token pool** → paste an account token, set a label, priority and how many parallel builds it can take
   (encrypted with AES-256-GCM, masked in the UI).
2. **Deploy** → keep the token on *Auto · best free slot* or pick one explicitly.
3. **Users** shows every visitor with their deployment history and a block/delete action;
   **Deployments** shows every build with logs, cancel and delete.

### Keeping it 24/7

- Every deploy automatically sets **Restart Policy = ALWAYS**, and detects a start command
  (`python main.py`, `npm start`, `node index.js`, …) when no Dockerfile exists.
- Railway keeps containers running on Hobby/Pro plans (free trial has limits).
- The panel itself can run 24/7 on Railway — this repo includes `Dockerfile` + `railway.json`
  (`restartPolicyType: ALWAYS`, health check `/api/health`).

| Host the panel on | 24/7? | Notes |
|---|---|---|
| Railway (this repo) | ✅ | Push repo → New Project → Deploy from repo; set `ADMIN_PASSWORD`, `APP_SECRET` env vars |
| Docker / VPS | ✅ | `docker compose up -d --build` (restart: unless-stopped) |
| Your PC | ⚠️ | Only while PC is on and not asleep; use PM2/NSSM if you want auto-restart |

Windows auto-start (optional): `npm i -g pm2` → `pm2 start server.js --name ghosthost` → `pm2 save` → `pm2-startup install`.

---

## 5. MongoDB (optional, unlimited URLs)

Add URLs in either place:

**A. `.env`**

```
MONGODB_URLS=mongodb+srv://user:pass@cluster0.mongodb.net,mongodb+srv://user:pass@cluster1.mongodb.net
MONGODB_DB=ghosthost
```

**B. Owner console → Database**

- Add a label + connection string. Test it, activate it, or delete it.
- The active URL is used first; the others are automatic backups.
- If the active database fails mid-operation, the next URL is tried automatically.
- If every URL fails, GHOST HOST falls back to `data/db.json` so deploys never stop.
- URLs are encrypted at rest; the UI only shows a masked host.

---

## 6. Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `ADMIN_PASSWORD` | `owner` | Owner console password (set your own; never shown in UI) |
| `APP_SECRET` | random (saved in `data/.secret`) | Session signing + AES-256-GCM encryption |
| `PORT` | `3000` | Panel port |
| `MAX_ZIP_MB` | `1024` | Max ZIP upload size |
| `MAX_ENTRIES` | `20000` | Max files inside a ZIP |
| `MAX_EXTRACT_GB` | `4` | Max unpacked size |
| `DEPLOY_TIMEOUT_MIN` | `25` | How long to wait for Railway status |
| `MAX_RUNNING` | `2` | Concurrent deployments |
| `PUBLIC_DEPLOYS_PER_HOUR` | `8` | Public deploys allowed per visitor and per IP each hour |
| `PUBLIC_ACTIVE_JOBS` | `2` | Simultaneous public builds per visitor |
| `MONGODB_URLS` | — | Comma/newline separated MongoDB URLs |
| `MONGODB_DB` | `ghosthost` | MongoDB database name |

Set `ADMIN_PASSWORD` and `APP_SECRET` before exposing the panel to the internet.

---

## 7. Security model

- Owner password → signed HttpOnly cookie (HMAC-SHA256), rate-limited login.
- Public deploys never receive a Railway token: the server reserves a pool slot and runs the build itself.
- Owner tokens and MongoDB URLs are stored **AES-256-GCM encrypted**; the UI only sees masked values.
- Each browser gets a random HttpOnly visitor id so the owner can attribute builds; no personal data is
  collected beyond the name the visitor types and their IP.
- ZIP extraction blocks path traversal (`../`) and enforces entry/size limits.
- Security headers (CSP, nosniff, frame options, no referrer).
- Tokens are used server-side by the Railway CLI and GraphQL API only.

> Do not commit `.env` or `data/`. If you ever shared a token, rotate it at railway.com/account/tokens.

---

## 8. Project layout

```
sakurahost/
├── server.js            # Express API + auth + free deploys + static hosting
├── lib/
│   ├── config.js        # env + paths
│   ├── vault.js         # AES-256-GCM encrypt/decrypt
│   ├── db.js            # MongoDB failover + JSON snapshot + tokens/users/deployments
│   ├── railway.js       # Railway GraphQL client
│   ├── zip.js           # safe ZIP extraction
│   ├── jobs.js          # queue, pool slot reserve/release, SSE live logs
│   └── deploy.js        # ZIP (Railway CLI) and GitHub (GraphQL) deploys
├── public/
│   ├── index.html       # landing + pool deploy + owner console
│   ├── css/style.css    # dark hosting-panel design system
│   └── js/
│       ├── scene.js     # subtle Three.js wireframe background
│       └── app.js       # free deploy + console logic
├── Dockerfile
├── docker-compose.yml
└── railway.json
```

---

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| `Not Authorized` when saving a token | Use an **Account/Workspace** token (not a Project token), and copy the full token |
| Deployment fails immediately | Check the live terminal; `main.py`/`requirements.txt` must be at the ZIP root (or one folder inside) |
| No public URL | The service may not expose a port; for bots that's fine |
| `ZIP is bigger than N MB` | Raise `MAX_ZIP_MB` in `.env` and restart |
| GitHub deploy does nothing | Repo must be public or GitHub connected inside Railway; check the branch name |
| Panel forgets tokens after redeploy | On Railway, mount a volume at `/app/data` (or keep the container volume in Docker) |
| Database banner says local JSON | Add/activate a MongoDB URL in the Database tab, or set `MONGODB_URLS` |

---

## 10. Notes

- Deployments consume **the owner's Railway account** usage/credits — the panel is the remote control.
- Pool slots free themselves when a build finishes, fails or is canceled; a token Railway rejects is
  marked and skipped until the owner re-checks it.
- The 3D background is generated with Three.js — no external images needed.

Made with 👻 for people who like their infrastructure pretty.
