# GHOST HOST — Free 24/7 deploy guide (PC band hone ke baad bhi chale)

Is guide me panel ko **Render Free** par host karenge, data **MongoDB Atlas Free** me rahega, aur
**cron-job.org** ka free ping panel ko sone nahi dega. Total kharch: ₹0.

> Deployed apps pehle se Railway par 24/7 chalte hain — ye guide sirf panel ke liye hai.
> `.env` kabhi GitHub par upload mat karna. Owner password sirf Render ke env vars me daalna.

---

## Step 1 — MongoDB Atlas free cluster (data yahan rahega)

1. <https://www.mongodb.com/cloud/atlas/register> → Google/GitHub se sign up.
2. **Create** → **M0 FREE** → region **Mumbai (ap-south-1)** ya **Singapore** → **Create Deployment**.
3. Left menu **Database Access** → **Add New Database User**:
   - Username: `ghost`
   - Password: **Autogenerate** → password copy karke rakh lo
   - Role: `Atlas admin` → **Add User**
4. Left menu **Network Access** → **Add IP Address** → **Allow Access from Anywhere** (`0.0.0.0/0`) → Confirm.
5. **Database** → **Connect** → **Drivers** → connection string copy karo, aisa dikhega:
   `mongodb+srv://ghost:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`

   Isme 2 badlav karo:
   - `<password>` ki jagah apna password
   - `.net/` ke baad `ghosthost` add karo, final:
   `mongodb+srv://ghost:PASSWORD@cluster0.xxxxx.mongodb.net/ghosthost?retryWrites=true&w=majority`

## Step 2 — Local panel ka data Mongo me bhejo (3 tokens transfer)

1. Local panel chalao: `start-ghost.bat` double-click.
2. Owner console → **Database** tab → Label: `Atlas` → upar wala connection string paste karo → **Save & connect**.
3. Banner green (MongoDB connected) aana chahiye. Ab Token pool ke 3 tokens Atlas me save ho gaye.
   (Naye tokens bhi ab automatic Mongo me jayenge.)

## Step 3 — GitHub par code upload (private repo)

1. <https://github.com/new> → Repository name: `ghosthost` → **Private** → **Create repository**.
2. **uploading an existing file** link par click karo.
3. Is folder (`sakurahost`) se **sirf ye cheezein** drag karo:
   `server.js`, `lib/`, `public/`, `package.json`, `package-lock.json`, `render.yaml`, `README.md`,
   `.env.example`, `.gitignore` (aur chaho to `start-ghost.bat`)
4. **Kabhi upload mat karo:** `node_modules/`, `.env`, `data/`, `uploads/`, `work/`
5. **Commit changes** dabao.

## Step 4 — Render free web service

1. <https://render.com> → **Get Started** → **GitHub** se sign up → repo access allow karo.
2. Dashboard → **New +** → **Blueprint** → `ghosthost` repo select karo → **Apply**.
3. Env values maangega, ye bharo:
   - `ADMIN_PASSWORD` → wahi owner password jo local panel me hai
   - `APP_SECRET` → local `.env` se `APP_SECRET` ki value **copy-paste** (ye zaroori hai, warna Mongo
     wale tokens decrypt nahi honge)
   - `MONGODB_URL` → Step 1 wala Atlas string
4. **Create / Apply** → 3–5 min build → URL milega jaise `https://ghosthost-xxxx.onrender.com`.

## Step 5 — Check karo

1. Render wala URL kholo → panel khule.
2. **Owner console** → login → **Token pool** me teeno tokens dikhne chahiye (Mongo se aa gaye).
   Agar nahi dikhe to wahi 3 tokens dobara paste kar do — Mongo me save ho jayenge.
3. Public page par **slots free** dikhna chahiye; deploy test kar sakte ho.

## Step 6 — 24/7 jagaye rakho (Render free 15 min baad sota hai)

**cron-job.org (free, recommended):**

1. <https://cron-job.org> → Sign up → **Create cronjob**.
2. Title: `GHOST HOST ping`
3. URL: `https://ghosthost-xxxx.onrender.com/api/health`
4. Schedule: **Every 5 minutes** → **Create**.
5. Test-run karke 200 OK confirm karo.

**Alternative:** UptimeRobot free → HTTP(s) monitor → 5 min interval → same URL.

Isse Render har 5 min me traffic dekhta hai aur so nahi paata. PC band ho ya aap so jao — panel chalta rahega.

---

## Dhyan rakhne wali baatein

- Render free me **750 hours/month** milte hain — ek service ke 24/7 chalne ke liye kaafi hai.
- Platform redeploy/maintenance par 1–2 min down ho sakta hai. Build ke waqt panel restart hua to woh
  build cancel ho sakta hai — dobara deploy kar dena. Data Mongo me safe rehta hai.
- Free instance 512 MB RAM ka hai — `MAX_RUNNING=2` (ek saath 2 build) ke liye theek hai.
- Render free par disk temporary hoti hai, isliye **MongoDB compulsory** hai.
- `.env` / password kabhi repo ya chat me mat daalna; sirf Render env me.

## Agar Render ke cold start / limits pasand na aaye

Oracle Cloud **Always Free** ARM VM (card verification hoti hai, charge nahi) me ye panel bina sone ke
chalega. Setup thoda technical hai (SSH + server). Chaho to uske liye alag step-by-step guide bana denge.
