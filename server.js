const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const config = require("./lib/config");
const db = require("./lib/db");
const rw = require("./lib/railway");
const jobs = require("./lib/jobs");
const deploy = require("./lib/deploy");

const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' https://unpkg.com https://cdn.jsdelivr.net",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob: https:",
      "connect-src 'self' https://unpkg.com https://cdn.jsdelivr.net",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
    ].join("; ")
  );
  next();
});

const SESSION_VALUE = crypto
  .createHmac("sha256", config.APP_SECRET)
  .update("ghost-owner-session")
  .digest("hex");

function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/* Every browser gets a private visitor id — that is how the owner sees who deployed what. */
app.use((req, res, next) => {
  let key = readCookie(req, "ghost_visitor");
  if (!key || !/^[a-f0-9]{32}$/.test(key)) {
    key = crypto.randomBytes(16).toString("hex");
    const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
    res.append(
      "Set-Cookie",
      `ghost_visitor=${key}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${365 * 24 * 3600}${secure ? "; Secure" : ""}`
    );
  }
  req.visitor = key;
  next();
});

function isAuthed(req) {
  const value = readCookie(req, "ghost_session");
  if (!value) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(SESSION_VALUE);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function setSessionCookie(req, res) {
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.append(
    "Set-Cookie",
    `ghost_session=${SESSION_VALUE}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${7 * 24 * 3600}${
      secure ? "; Secure" : ""
    }`
  );
}

function clearSessionCookie(res) {
  res.append("Set-Cookie", "ghost_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0");
}

const loginBucket = new Map();
function loginLimited(ip) {
  const now = Date.now();
  const bucket = loginBucket.get(ip) || { count: 0, reset: now + 10 * 60 * 1000 };
  if (now > bucket.reset) {
    bucket.count = 0;
    bucket.reset = now + 10 * 60 * 1000;
  }
  bucket.count += 1;
  loginBucket.set(ip, bucket);
  return bucket.count > 8;
}

const publicBucket = new Map();
function publicLimited(key) {
  const now = Date.now();
  const bucket = publicBucket.get(key) || { count: 0, reset: now + 60 * 60 * 1000 };
  if (now > bucket.reset) {
    bucket.count = 0;
    bucket.reset = now + 60 * 60 * 1000;
  }
  bucket.count += 1;
  publicBucket.set(key, bucket);
  return bucket.count > config.PUBLIC_DEPLOYS_PER_HOUR;
}

function ah(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: "Not signed in" });
}

app.get("/api/health", (req, res) => res.json({ ok: true, version: config.VERSION }));

app.get("/api/session", (req, res) => {
  res.json({
    authed: isAuthed(req),
    version: config.VERSION,
    uptimeSec: Math.round(process.uptime()),
  });
});

app.get(
  "/api/meta",
  ah(async (req, res) => {
    res.json({
      version: config.VERSION,
      maxZipMB: config.MAX_ZIP_MB,
      deployTimeoutMin: config.DEPLOY_TIMEOUT_MIN,
      publicLimitPerHour: config.PUBLIC_DEPLOYS_PER_HOUR,
      storage: (await db.dbStatus()).mode,
    });
  })
);

app.post("/api/login", (req, res) => {
  const ip = req.ip || "local";
  if (loginLimited(ip)) {
    return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
  }
  const password = String(req.body?.password || "");
  const expected = Buffer.from(config.ADMIN_PASSWORD);
  const given = Buffer.from(password);
  const ok =
    given.length === expected.length && crypto.timingSafeEqual(given, expected);
  if (!ok) return res.status(401).json({ error: "Wrong password" });
  loginBucket.delete(ip);
  setSessionCookie(req, res);
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

/* ---------------- Public: pool deploy, no token needed ---------------- */

async function publicGate(req) {
  const user = await db.getUser(req.visitor);
  if (user?.banned) {
    const err = new Error("This visitor has been blocked by the owner.");
    err.status = 403;
    throw err;
  }
  if (jobs.activeFor(req.visitor) >= config.PUBLIC_ACTIVE_JOBS) {
    const err = new Error("You already have deployments running. Wait for them to finish.");
    err.status = 429;
    throw err;
  }
  if (publicLimited(`ip:${req.ip || "local"}`) || publicLimited(`v:${req.visitor}`)) {
    const err = new Error(`Free limit reached (${config.PUBLIC_DEPLOYS_PER_HOUR} deploys per hour). Try later.`);
    err.status = 429;
    throw err;
  }
  const pool = await db.poolStatus();
  if (!pool.free) {
    const err = new Error("All deployment slots are busy right now. Try again in a few minutes.");
    err.status = 503;
    throw err;
  }
  return { pool, user };
}

function cleanUserName(value) {
  return String(value || "")
    .replace(/[^\p{L}\p{N} ._-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24);
}

async function registerVisitor(req, providedName) {
  const name = cleanUserName(providedName);
  const existing = await db.getUser(req.visitor);
  if (existing?.banned) {
    const err = new Error("This visitor has been blocked by the owner.");
    err.status = 403;
    throw err;
  }
  if (!name && !existing) {
    const err = new Error("Enter your name so the owner knows who deployed.");
    err.status = 400;
    throw err;
  }
  if (name && name.length < 2) {
    const err = new Error("Name needs at least 2 characters.");
    err.status = 400;
    throw err;
  }
  const user = await db.touchUser({
    key: req.visitor,
    name: name || existing?.name || "Guest",
    ip: req.ip || "",
    ua: req.headers["user-agent"] || "",
  });
  return user;
}

app.get(
  "/api/public/status",
  ah(async (req, res) => {
    const [pool, deps] = await Promise.all([db.poolStatus(), db.listDeployments()]);
    const publicDeps = deps.filter((d) => d.via === "public");
    const users = new Set(publicDeps.map((d) => d.userKey).filter(Boolean));
    res.json({
      ok: true,
      pool,
      stats: {
        deploys: publicDeps.length,
        builders: users.size,
        live: publicDeps.filter((d) => d.status === "success").length,
      },
      recent: publicDeps.slice(0, 6).map((d) => ({
        id: d.id,
        name: d.projectName || d.name,
        user: d.userName || "Guest",
        status: d.status,
        type: d.type,
        createdAt: d.createdAt,
        url: d.deploymentUrl || "",
      })),
    });
  })
);

const upload = multer({
  dest: config.UPLOAD_DIR,
  limits: { fileSize: config.MAX_ZIP_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ok = /\.zip$/i.test(file.originalname || "");
    cb(ok ? null : new Error("Only .zip archives are accepted"), ok);
  },
});

app.post(
  "/api/public/deploy/zip",
  upload.single("file"),
  ah(async (req, res) => {
    let keep = false;
    try {
      if (!req.file) return res.status(400).json({ error: "Attach a .zip file to deploy." });
      const projectName = normalizeName(req.body?.projectName);
      if (!projectName) {
        return res.status(400).json({ error: "Project name needs 2-60 characters (letters, numbers, - or _)." });
      }
      await publicGate(req);
      const user = await registerVisitor(req, req.body?.username);

      const job = jobs.createJob({
        type: "zip",
        name: projectName,
        projectName,
        zipPath: req.file.path,
        via: "public",
        userKey: req.visitor,
        userName: user.name,
      });
      keep = true;
      res.json({ ok: true, job: jobs.publicJob(job), key: job.accessKey });
    } finally {
      if (req.file?.path && !keep) fs.rmSync(req.file.path, { force: true });
    }
  })
);

app.post(
  "/api/public/deploy/github",
  ah(async (req, res) => {
    const projectName = normalizeName(req.body?.projectName);
    const repo = normalizeRepo(req.body?.repo);
    const branch = String(req.body?.branch || "").trim().slice(0, 100);
    if (!projectName) return res.status(400).json({ error: "Project name needs 2-60 characters." });
    if (!repo) return res.status(400).json({ error: "Use owner/repo or a github.com URL." });
    await publicGate(req);
    const user = await registerVisitor(req, req.body?.username);

    const job = jobs.createJob({
      type: "github",
      name: projectName,
      projectName,
      repo,
      branch,
      via: "public",
      userKey: req.visitor,
      userName: user.name,
    });
    res.json({ ok: true, job: jobs.publicJob(job), key: job.accessKey });
  })
);

function sameKey(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

async function publicJob(req) {
  const job = jobs.jobs.get(req.params.id);
  const key = String(req.query.key || req.body?.key || "");
  if (job) {
    if (job.userKey === req.visitor || sameKey(key, job.accessKey)) return job;
    return null;
  }
  const row = await db.findDeployment(req.params.id);
  if (!row) return null;
  if (row.userKey && row.userKey === req.visitor) return row;
  if (row.accessHash && sameKey(db.hashKey(key), row.accessHash)) return row;
  return null;
}

app.get(
  "/api/public/my",
  ah(async (req, res) => {
    const mine = [...jobs.jobs.values()]
      .filter((j) => j.userKey === req.visitor)
      .map(jobs.publicJob);
    const seen = new Set(mine.map((j) => j.id));
    const history = (await db.listDeployments()).filter(
      (d) => d.userKey === req.visitor && !seen.has(d.id)
    );
    const merged = [...mine, ...history]
      .map(({ accessHash, ...rest }) => rest)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, 12);
    const user = await db.getUser(req.visitor);
    res.json({ ok: true, user: user ? { name: user.name, banned: Boolean(user.banned) } : null, jobs: merged });
  })
);

app.get(
  "/api/public/jobs/:id",
  ah(async (req, res) => {
    const job = await publicJob(req);
    if (!job) return res.status(404).json({ error: "Job not found" });
    const live = jobs.jobs.get(req.params.id);
    if (live) return res.json({ job: { ...jobs.publicJob(live), logs: live.logs } });
    const { accessHash, ...safe } = job;
    res.json({ job: safe });
  })
);

app.get(
  "/api/public/jobs/:id/stream",
  ah(async (req, res) => {
    const live = jobs.jobs.get(req.params.id);
    const key = String(req.query.key || "");
    if (!live || !(live.userKey === req.visitor || sameKey(key, live.accessKey))) {
      return res.status(404).json({ error: "Job not found" });
    }
    jobs.stream(live, res);
  })
);

app.post(
  "/api/public/jobs/:id/cancel",
  ah(async (req, res) => {
    const job = await publicJob(req);
    if (!job) return res.status(404).json({ error: "Job not found" });
    const live = jobs.jobs.get(req.params.id);
    res.json({ ok: live ? jobs.cancelJob(live) : false });
  })
);

/* ---------------- Auth wall for owner API ---------------- */

app.use("/api", (req, res, next) => {
  const open =
    req.path === "/login" ||
    req.path === "/logout" ||
    req.path === "/session" ||
    req.path === "/meta" ||
    req.path === "/health" ||
    req.path.startsWith("/public");
  if (open) return next();
  return requireAuth(req, res, next);
});

/* ---------------- Owner: token pool ---------------- */

app.get(
  "/api/tokens",
  ah(async (req, res) => {
    res.json({ tokens: await db.listTokens(), pool: await db.poolStatus() });
  })
);

app.post(
  "/api/tokens",
  ah(async (req, res) => {
    const secret = String(req.body?.token || "").trim();
    const label = String(req.body?.label || "").trim().slice(0, 40);
    if (secret.length < 20) {
      return res.status(400).json({ error: "That does not look like a valid deploy token." });
    }
    let info;
    try {
      info = await rw.checkToken(secret);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const id = await db.addToken({
      label: label || info.email || "Deploy token",
      secret,
      email: info.email,
      kind: info.kind,
      note: info.note,
      maxDeployments: req.body?.maxDeployments,
      priority: req.body?.priority,
    });
    res.json({ ok: true, id, info, pool: await db.poolStatus() });
  })
);

app.patch(
  "/api/tokens/:id",
  ah(async (req, res) => {
    const ok = await db.updateToken(req.params.id, {
      label: req.body?.label,
      active: req.body?.active,
      maxDeployments: req.body?.maxDeployments,
      priority: req.body?.priority,
    });
    res.json({ ok, tokens: await db.listTokens(), pool: await db.poolStatus() });
  })
);

app.post(
  "/api/tokens/:id/check",
  ah(async (req, res) => {
    const secret = await db.getTokenSecret(req.params.id);
    if (!secret) return res.status(404).json({ error: "Token not found" });
    try {
      const info = await rw.checkToken(secret);
      await db.markTokenOk(req.params.id, info);
      res.json({ ok: true, info, tokens: await db.listTokens(), pool: await db.poolStatus() });
    } catch (err) {
      await db.markTokenError(req.params.id, err.message);
      res.status(400).json({ error: err.message, tokens: await db.listTokens() });
    }
  })
);

app.delete(
  "/api/tokens/:id",
  ah(async (req, res) => {
    res.json({ ok: await db.removeToken(req.params.id), pool: await db.poolStatus() });
  })
);

/* ---------------- Owner: who deployed what ---------------- */

app.get(
  "/api/overview",
  ah(async (req, res) => {
    const live = [...jobs.jobs.values()].map(jobs.publicJob);
    res.json(await db.overview(live));
  })
);

app.get(
  "/api/users",
  ah(async (req, res) => {
    res.json({ users: await db.listUsers() });
  })
);

app.post(
  "/api/users/:key/ban",
  ah(async (req, res) => {
    await db.setUserBanned(req.params.key, Boolean(req.body?.banned));
    res.json({ ok: true, users: await db.listUsers() });
  })
);

app.delete(
  "/api/users/:key",
  ah(async (req, res) => {
    await db.removeUser(req.params.key);
    res.json({ ok: true, users: await db.listUsers() });
  })
);

/* ---------------- Owner: Railway projects ---------------- */

async function anyTokenSecret(explicitId) {
  if (explicitId) {
    const secret = await db.getTokenSecret(String(explicitId));
    if (secret) return secret;
  }
  const tokens = await db.listTokens();
  for (const token of tokens) {
    if (!token.active || token.status === "error") continue;
    const secret = await db.getTokenSecret(token.id);
    if (secret) return secret;
  }
  return null;
}

app.get(
  "/api/host/projects",
  ah(async (req, res) => {
    const tokens = (await db.listTokens()).filter((t) => t.active && t.status !== "error");
    if (!tokens.length) return res.status(400).json({ error: "Add a deploy token to the pool first" });
    const projects = [];
    const seen = new Set();
    let lastError = null;
    for (const token of tokens) {
      const secret = await db.getTokenSecret(token.id);
      if (!secret) continue;
      try {
        for (const project of await rw.listProjects(secret)) {
          if (!project.id || seen.has(project.id)) continue;
          seen.add(project.id);
          projects.push({ ...project, tokenLabel: token.label });
        }
      } catch (err) {
        lastError = err;
      }
    }
    if (!projects.length && lastError) throw lastError;
    res.json({ projects });
  })
);

app.get("/api/open/project/:id", (req, res) => {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(req.params.id)) return res.status(400).end();
  res.redirect(302, `https://railway.com/project/${req.params.id}`);
});

app.get(
  "/api/host/projects/:id",
  ah(async (req, res) => {
    const secret = await anyTokenSecret(req.query.tokenId);
    if (!secret) return res.status(400).json({ error: "Add a deploy token to the pool first" });
    const project = await rw.projectInfo(secret, req.params.id);
    const withDeployments = [];
    for (const service of project.services) {
      let latest = [];
      try {
        latest = await rw.listDeployments(secret, {
          projectId: project.id,
          serviceId: service.id,
          environmentId: project.environments[0]?.id,
          first: 3,
        });
      } catch {
        /* ignore per-service errors */
      }
      withDeployments.push({ ...service, deployments: latest });
    }
    res.json({
      project: {
        ...project,
        services: withDeployments,
        dashboardUrl: `https://railway.com/project/${project.id}`,
      },
    });
  })
);

app.delete(
  "/api/host/projects/:id",
  ah(async (req, res) => {
    const secret = await anyTokenSecret(req.query.tokenId);
    if (!secret) return res.status(400).json({ error: "Add a deploy token to the pool first" });
    await rw.deleteProject(secret, req.params.id);
    res.json({ ok: true });
  })
);

/* ---------------- Database management (owner) ---------------- */

app.get(
  "/api/db/status",
  ah(async (req, res) => {
    res.json(await db.dbStatus());
  })
);

app.post(
  "/api/db/urls",
  ah(async (req, res) => {
    res.json(
      await db.addDbUrl({
        label: req.body?.label,
        url: req.body?.url,
      })
    );
  })
);

app.post(
  "/api/db/urls/:id/test",
  ah(async (req, res) => {
    res.json(await db.testDbUrl(req.params.id));
  })
);

app.post(
  "/api/db/urls/:id/activate",
  ah(async (req, res) => {
    res.json(await db.activateDbUrl(req.params.id));
  })
);

app.delete(
  "/api/db/urls/:id",
  ah(async (req, res) => {
    res.json({ ok: true, status: await db.removeDbUrl(req.params.id) });
  })
);

/* ---------------- Owner deploys (pool or chosen token) ---------------- */

app.post(
  "/api/deploy/zip",
  upload.single("file"),
  ah(async (req, res) => {
    let keep = false;
    try {
      if (!req.file) return res.status(400).json({ error: "Attach a .zip file to deploy." });
      const projectName = normalizeName(req.body?.projectName);
      if (!projectName) {
        return res.status(400).json({ error: "Project name needs 2-60 characters (letters, numbers, - or _)." });
      }
      const pool = await db.poolStatus();
      if (!pool.free) return res.status(503).json({ error: "Every token slot is busy right now." });

      const job = jobs.createJob({
        type: "zip",
        name: projectName,
        projectName,
        preferredTokenId: String(req.body?.tokenId || ""),
        zipPath: req.file.path,
        via: "owner",
        userName: "Owner",
      });
      keep = true;
      res.json({ ok: true, job: jobs.publicJob(job) });
    } finally {
      if (req.file?.path && !keep) fs.rmSync(req.file.path, { force: true });
    }
  })
);

app.post(
  "/api/deploy/github",
  ah(async (req, res) => {
    const projectName = normalizeName(req.body?.projectName);
    const repo = normalizeRepo(req.body?.repo);
    const branch = String(req.body?.branch || "").trim().slice(0, 100);
    if (!projectName) return res.status(400).json({ error: "Project name needs 2-60 characters." });
    if (!repo) return res.status(400).json({ error: "Use owner/repo or a github.com URL." });
    const pool = await db.poolStatus();
    if (!pool.free) return res.status(503).json({ error: "Every token slot is busy right now." });

    const job = jobs.createJob({
      type: "github",
      name: projectName,
      projectName,
      repo,
      branch,
      preferredTokenId: String(req.body?.tokenId || ""),
      via: "owner",
      userName: "Owner",
    });
    res.json({ ok: true, job: jobs.publicJob(job) });
  })
);

/* ---------------- Owner: jobs ---------------- */

app.get(
  "/api/jobs",
  ah(async (req, res) => {
    const live = [...jobs.jobs.values()].map(jobs.publicJob);
    const seen = new Set(live.map((j) => j.id));
    const history = (await db.listDeployments())
      .filter((d) => !seen.has(d.id))
      .map(({ accessHash, logs, ...rest }) => rest);
    const merged = [...live, ...history].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    res.json({ jobs: merged });
  })
);

app.get(
  "/api/jobs/:id",
  ah(async (req, res) => {
    const job = jobs.jobs.get(req.params.id);
    if (job) return res.json({ job: { ...jobs.publicJob(job), logs: job.logs } });
    const history = await db.findDeployment(req.params.id);
    if (!history) return res.status(404).json({ error: "Job not found" });
    const { accessHash, ...safe } = history;
    res.json({ job: safe });
  })
);

app.get("/api/jobs/:id/stream", (req, res) => {
  const job = jobs.jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  jobs.stream(job, res);
});

app.post("/api/jobs/:id/cancel", (req, res) => {
  const job = jobs.jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({ ok: jobs.cancelJob(job) });
});

app.delete(
  "/api/jobs/:id",
  ah(async (req, res) => {
    await db.removeDeployment(req.params.id);
    res.json({ ok: true });
  })
);

function normalizeName(value) {
  const name = String(value || "")
    .replace(/[\u0000-\u001f<>{}$`]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
  return /^[A-Za-z0-9][A-Za-z0-9._-]{1,59}$/.test(name) ? name : "";
}

function normalizeRepo(value) {
  let raw = String(value || "").trim().replace(/\.git$/i, "");
  raw = raw.replace(/^https?:\/\/(www\.)?github\.com\//i, "");
  raw = raw.replace(/\/+$/, "");
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw) ? raw : "";
}

app.use(express.static(path.join(config.ROOT, "public"), { extensions: ["html"] }));

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(config.ROOT, "public", "index.html"));
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof multer.MulterError) {
    const message =
      err.code === "LIMIT_FILE_SIZE"
        ? `ZIP is bigger than ${config.MAX_ZIP_MB} MB.`
        : `Upload failed: ${err.message}`;
    return res.status(400).json({ error: message });
  }
  if (err && /Only \.zip/.test(err.message || "")) {
    return res.status(400).json({ error: err.message });
  }
  const status = err?.status || 500;
  if (status >= 500) console.error("API error:", err);
  res.status(status).json({ error: err?.message || "Something went wrong" });
});

async function main() {
  await db.init();
  await jobs.recover();
  jobs.setRunner(deploy.runJob);
  const status = await db.dbStatus();

  app.listen(config.PORT, "0.0.0.0", () => {
    const line = "─".repeat(52);
    console.log(`\n${line}`);
    console.log("  👻 GHOST HOST  —  free deploy panel");
    console.log(`  Local:   http://localhost:${config.PORT}`);
    console.log(`  Version: ${config.VERSION}`);
    console.log(`  Storage: ${status.mode === "mongo" ? "MongoDB" : "local JSON (fallback)"}`);
    console.log(`${line}\n`);
  });
}

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
