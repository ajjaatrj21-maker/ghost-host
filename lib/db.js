const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { MongoClient } = require("mongodb");
const { DATA_DIR } = require("./config");
const { encrypt, decrypt, newId } = require("./vault");

const DB_FILE = path.join(DATA_DIR, "db.json");
const URL_FILE = path.join(DATA_DIR, "databases.json");
const MONGO_DB = process.env.MONGODB_DB || "ghosthost";

/* ---------------- JSON snapshot (always kept in sync) ---------------- */

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

const json = readJson(DB_FILE, {});
json.tokens ||= [];
json.deployments ||= [];
json.users ||= [];

let saveTimer = null;
function saveJsonNow() {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(json));
  fs.renameSync(tmp, DB_FILE);
}
function saveJson() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      saveJsonNow();
    } catch {
      /* ignore */
    }
  }, 250);
}

/* Normalise token rows written by older versions. */
for (const t of json.tokens) {
  if (t.active === undefined) t.active = true;
  if (t.current === undefined) t.current = 0;
  if (t.total === undefined) t.total = 0;
  if (t.maxDeployments === undefined) t.maxDeployments = 1;
  if (t.priority === undefined) t.priority = 0;
}

/* ---------------- Mongo URL list ---------------- */

let urlRows = readJson(URL_FILE, { urls: [] }).urls || [];

function envUrls() {
  const raw = [process.env.MONGODB_URLS || "", process.env.MONGODB_URL || ""].join("\n");
  const seen = new Set();
  const out = [];
  raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((url, index) => {
      if (seen.has(url)) return;
      seen.add(url);
      out.push({ id: `env_${index + 1}`, label: `Env URL ${index + 1}`, url, fromEnv: true });
    });
  return out;
}

function storedUrls() {
  return urlRows
    .map((row) => {
      try {
        return { id: row.id, label: row.label, url: decrypt(row.urlEnc), fromEnv: false };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function allUrls() {
  return [...envUrls(), ...storedUrls()];
}

function saveUrlRows() {
  const tmp = URL_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ urls: urlRows }));
  fs.renameSync(tmp, URL_FILE);
}

function maskUrl(value) {
  try {
    const parsed = new URL(value);
    const auth = parsed.username || parsed.password ? "••••••@" : "";
    const db = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "";
    return `${parsed.protocol}//${auth}${parsed.hostname}${db}`;
  } catch {
    return "hidden";
  }
}

/* ---------------- Connection manager ---------------- */

const mgr = {
  client: null,
  db: null,
  mode: "json",
  activeId: null,
  lastError: "",
  lastCheck: null,
};

async function openClient(url) {
  const client = new MongoClient(url, {
    serverSelectionTimeoutMS: 4000,
    connectTimeoutMS: 5000,
    maxPoolSize: 6,
  });
  await client.connect();
  const db = client.db(MONGO_DB);
  await db.command({ ping: 1 });
  return { client, db };
}

async function seedFromJson(db) {
  const tokensCount = await db.collection("tokens").countDocuments();
  if (tokensCount === 0 && json.tokens.length) {
    await db.collection("tokens").insertMany(json.tokens).catch(() => {});
  }
  const depCount = await db.collection("deployments").countDocuments();
  if (depCount === 0 && json.deployments.length) {
    await db.collection("deployments").insertMany(json.deployments).catch(() => {});
  }
  const userCount = await db.collection("users").countDocuments();
  if (userCount === 0 && json.users.length) {
    await db.collection("users").insertMany(json.users).catch(() => {});
  }
}

async function connectBest(startIndex = 0) {
  const urls = allUrls();
  if (!urls.length) {
    mgr.mode = "json";
    mgr.activeId = null;
    mgr.lastError = "";
    return false;
  }
  for (let i = 0; i < urls.length; i += 1) {
    const entry = urls[(startIndex + i) % urls.length];
    try {
      if (mgr.client) {
        try {
          await mgr.client.close();
        } catch {
          /* ignore */
        }
      }
      const { client, db } = await openClient(entry.url);
      await db.collection("tokens").createIndex({ id: 1 }, { unique: true }).catch(() => {});
      await db.collection("deployments").createIndex({ id: 1 }, { unique: true }).catch(() => {});
      await db.collection("deployments").createIndex({ createdAt: -1 }).catch(() => {});
      await db.collection("deployments").createIndex({ userKey: 1 }).catch(() => {});
      await db.collection("users").createIndex({ key: 1 }, { unique: true }).catch(() => {});
      await seedFromJson(db);
      mgr.client = client;
      mgr.db = db;
      mgr.mode = "mongo";
      mgr.activeId = entry.id;
      mgr.lastError = "";
      mgr.lastCheck = new Date().toISOString();
      return true;
    } catch (err) {
      mgr.lastError = `${entry.label}: ${err.message}`;
    }
  }
  mgr.mode = "json";
  mgr.client = null;
  mgr.db = null;
  mgr.activeId = null;
  mgr.lastCheck = new Date().toISOString();
  return false;
}

async function withMongo(run, fallback) {
  if (mgr.mode !== "mongo" || !mgr.db) return fallback();
  try {
    return await run(mgr.db);
  } catch (err) {
    mgr.lastError = err.message;
    const urls = allUrls();
    const idx = Math.max(0, urls.findIndex((u) => u.id === mgr.activeId));
    const switched = urls.length > 1 ? await connectBest((idx + 1) % urls.length) : false;
    if (switched) {
      try {
        return await run(mgr.db);
      } catch (retryErr) {
        mgr.lastError = retryErr.message;
      }
    }
    mgr.mode = "json";
    return fallback();
  }
}

/* ---------------- Tokens (the deploy pool) ---------------- */

function publicToken(t) {
  return {
    id: t.id,
    label: t.label,
    masked: `••••••••${t.last4 || ""}`,
    email: t.email || "",
    kind: t.kind || "account",
    status: t.status || "unknown",
    note: t.note || "",
    active: t.active !== false,
    maxDeployments: t.maxDeployments || 1,
    priority: t.priority || 0,
    current: t.current || 0,
    total: t.total || 0,
    lastError: t.lastError || "",
    addedAt: t.addedAt,
    lastCheck: t.lastCheck || null,
  };
}

async function rawTokens() {
  return withMongo(
    (db) => db.collection("tokens").find({}).toArray(),
    () => json.tokens
  );
}

async function listTokens() {
  return (await rawTokens()).map(publicToken);
}

async function getTokenSecret(id) {
  const row = await withMongo(
    (db) => db.collection("tokens").findOne({ id: String(id) }),
    () => json.tokens.find((t) => t.id === id) || null
  );
  if (!row) return null;
  try {
    return decrypt(row.secret);
  } catch {
    return null;
  }
}

async function addToken({ label, secret, email, kind, note, maxDeployments, priority }) {
  const existing = await rawTokens();
  const dup = existing.filter((t) => {
    try {
      return decrypt(t.secret) === secret;
    } catch {
      return false;
    }
  });
  if (dup.length) {
    const err = new Error("This Railway token is already in the pool.");
    err.status = 409;
    throw err;
  }
  const cap = Number(maxDeployments);
  const prio = Number(priority);
  const doc = {
    id: newId("tok"),
    label,
    secret: encrypt(secret),
    last4: secret.slice(-4),
    email: email || "",
    kind: kind || "account",
    status: "ok",
    note: note || "",
    active: true,
    maxDeployments: Number.isFinite(cap) && cap >= 1 ? Math.min(Math.round(cap), 50) : 1,
    priority: Number.isFinite(prio) ? Math.round(prio) : 0,
    current: 0,
    total: 0,
    addedAt: new Date().toISOString(),
    lastCheck: new Date().toISOString(),
    lastError: "",
  };
  await withMongo((db) => db.collection("tokens").insertOne({ ...doc }), async () => {});
  json.tokens.push(doc);
  saveJsonNow();
  return doc.id;
}

async function updateToken(id, patch) {
  const allowed = ["label", "status", "note", "active", "maxDeployments", "priority", "email", "kind", "lastCheck", "lastError"];
  const clean = {};
  for (const key of allowed) {
    if (patch[key] !== undefined) clean[key] = patch[key];
  }
  if (clean.maxDeployments !== undefined) {
    clean.maxDeployments = Math.max(1, Math.min(50, Math.round(Number(clean.maxDeployments) || 1)));
  }
  if (clean.priority !== undefined) clean.priority = Math.round(Number(clean.priority) || 0);
  await withMongo((db) => db.collection("tokens").updateOne({ id: String(id) }, { $set: clean }), async () => {});
  const token = json.tokens.find((t) => t.id === id);
  if (token) {
    Object.assign(token, clean);
    saveJsonNow();
    return true;
  }
  const exists = await withMongo(
    (db) => db.collection("tokens").findOne({ id: String(id) }),
    async () => null
  );
  return Boolean(exists);
}

async function removeToken(id) {
  await withMongo((db) => db.collection("tokens").deleteOne({ id: String(id) }), async () => {});
  const before = json.tokens.length;
  json.tokens = json.tokens.filter((t) => t.id !== id);
  saveJsonNow();
  return json.tokens.length !== before;
}

async function markTokenError(id, message) {
  if (!id) return;
  await updateToken(id, { status: "error", lastError: String(message || "").slice(0, 300), lastCheck: new Date().toISOString() });
}

async function markTokenOk(id, info = {}) {
  if (!id) return;
  const patch = {
    status: "ok",
    lastError: "",
    lastCheck: new Date().toISOString(),
  };
  if (info.email) patch.email = info.email;
  if (info.kind) patch.kind = info.kind;
  if (info.note) patch.note = info.note;
  await updateToken(id, patch);
}

/* Pick the best free slot: highest priority, then fewest running jobs, then least used. */
async function pickToken() {
  const rows = await rawTokens();
  const now = Date.now();
  const candidates = rows
    .filter((t) => t.active !== false && t.status !== "error")
    .filter((t) => (t.current || 0) < (t.maxDeployments || 1))
    .filter((t) => !t.cooldownUntil || new Date(t.cooldownUntil).getTime() < now)
    .sort(
      (a, b) =>
        (b.priority || 0) - (a.priority || 0) ||
        (a.current || 0) - (b.current || 0) ||
        (a.total || 0) - (b.total || 0)
    );
  const token = candidates[0];
  if (!token) return null;

  const nextCurrent = (token.current || 0) + 1;
  await withMongo(
    (db) => db.collection("tokens").updateOne({ id: token.id }, { $inc: { current: 1 } }),
    async () => {}
  );
  const local = json.tokens.find((t) => t.id === token.id);
  if (local) {
    local.current = nextCurrent;
    saveJsonNow();
  }
  let secret = "";
  try {
    secret = decrypt(token.secret);
  } catch {
    secret = "";
  }
  return { id: token.id, label: token.label, secret, priority: token.priority || 0 };
}

/* Reserve one slot on a specific token (owner picked it in the UI). */
async function reserveToken(id) {
  const row = await withMongo(
    (db) => db.collection("tokens").findOne({ id: String(id) }),
    () => json.tokens.find((t) => t.id === id) || null
  );
  if (!row) return null;
  if (row.active === false || row.status === "error") return null;
  if ((row.current || 0) >= (row.maxDeployments || 1)) return null;
  await withMongo((db) => db.collection("tokens").updateOne({ id: row.id }, { $inc: { current: 1 } }), async () => {});
  const local = json.tokens.find((t) => t.id === row.id);
  if (local) {
    local.current = (local.current || 0) + 1;
    saveJsonNow();
  }
  let secret = "";
  try {
    secret = decrypt(row.secret);
  } catch {
    secret = "";
  }
  return { id: row.id, label: row.label, secret };
}

async function releaseToken(id, { failed = false } = {}) {
  if (!id) return;
  const row = await withMongo(
    (db) => db.collection("tokens").findOne({ id: String(id) }),
    () => json.tokens.find((t) => t.id === id) || null
  );
  if (row) {
    const current = Math.max(0, (row.current || 0) - 1);
    const total = (row.total || 0) + 1;
    await withMongo(
      (db) => db.collection("tokens").updateOne({ id: String(id) }, { $set: { current, total } }),
      async () => {}
    );
  }
  const local = json.tokens.find((t) => t.id === id);
  if (local) {
    local.current = Math.max(0, (local.current || 0) - 1);
    local.total = (local.total || 0) + 1;
    saveJsonNow();
  }
  if (failed) {
    /* one failed run should not knock a token out of the pool forever */
  }
}

async function poolStatus() {
  const rows = await rawTokens();
  const active = rows.filter((t) => t.active !== false);
  const healthy = active.filter((t) => t.status !== "error");
  const capacity = healthy.reduce((sum, t) => sum + (t.maxDeployments || 1), 0);
  const used = healthy.reduce((sum, t) => sum + Math.min(t.current || 0, t.maxDeployments || 1), 0);
  return {
    tokens: rows.length,
    active: active.length,
    healthy: healthy.length,
    capacity,
    used,
    free: Math.max(0, capacity - used),
    deploys: rows.reduce((sum, t) => sum + (t.total || 0), 0),
  };
}

/* ---------------- Users (everyone who deploys) ---------------- */

function cleanName(value) {
  return String(value || "")
    .replace(/[^\p{L}\p{N} ._-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24);
}

function publicUser(u, deployments = []) {
  return {
    key: u.key,
    name: u.name || "Guest",
    ip: u.ip || "",
    deploys: deployments.length,
    lastSeen: u.lastSeen,
    createdAt: u.createdAt,
    banned: Boolean(u.banned),
    deployments: deployments.slice(0, 20),
  };
}

async function touchUser({ key, name, ip, ua }) {
  if (!key) return null;
  const now = new Date().toISOString();
  const existing = await withMongo(
    (db) => db.collection("users").findOne({ key }),
    () => json.users.find((u) => u.key === key) || null
  );
  const clean = cleanName(name);
  if (existing) {
    const patch = { lastSeen: now, ip: ip || existing.ip || "", ua: (ua || "").slice(0, 220) };
    if (clean) patch.name = clean;
    await withMongo((db) => db.collection("users").updateOne({ key }, { $set: patch }), async () => {});
    const local = json.users.find((u) => u.key === key);
    if (local) Object.assign(local, patch);
    saveJson();
    return { ...existing, ...patch };
  }
  const doc = {
    key,
    name: clean || "Guest",
    ip: ip || "",
    ua: (ua || "").slice(0, 220),
    banned: false,
    deploys: 0,
    lastSeen: now,
    createdAt: now,
  };
  await withMongo((db) => db.collection("users").insertOne({ ...doc }), async () => {});
  json.users.push(doc);
  saveJson();
  return doc;
}

async function getUser(key) {
  return withMongo(
    (db) => db.collection("users").findOne({ key }),
    () => json.users.find((u) => u.key === key) || null
  );
}

async function setUserBanned(key, banned) {
  await withMongo((db) => db.collection("users").updateOne({ key }, { $set: { banned: Boolean(banned) } }), async () => {});
  const local = json.users.find((u) => u.key === key);
  if (local) local.banned = Boolean(banned);
  saveJson();
  return true;
}

async function removeUser(key) {
  await withMongo((db) => db.collection("users").deleteOne({ key }), async () => {});
  json.users = json.users.filter((u) => u.key !== key);
  saveJsonNow();
  return true;
}

async function listUsers() {
  const users = await withMongo(
    (db) => db.collection("users").find({}).sort({ lastSeen: -1 }).toArray(),
    () => [...json.users].sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1))
  );
  const deps = await listDeployments();
  const byUser = new Map();
  for (const dep of deps) {
    if (!dep.userKey) continue;
    if (!byUser.has(dep.userKey)) byUser.set(dep.userKey, []);
    byUser.get(dep.userKey).push({
      id: dep.id,
      name: dep.projectName || dep.name,
      type: dep.type,
      status: dep.status,
      free: dep.via === "public",
      tokenLabel: dep.tokenLabel || "",
      deploymentUrl: dep.deploymentUrl || "",
      createdAt: dep.createdAt,
    });
  }
  return users.map((u) => publicUser(u, byUser.get(u.key) || []));
}

/* ---------------- Deployments ---------------- */

async function listDeployments(limit = 0) {
  return withMongo(
    (db) => {
      const cursor = db.collection("deployments").find({}).sort({ createdAt: -1 });
      return limit > 0 ? cursor.limit(limit).toArray() : cursor.toArray();
    },
    () => {
      const all = [...json.deployments].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return limit > 0 ? all.slice(0, limit) : all;
    }
  );
}

async function addDeployment(record) {
  const { keyHash, ...safe } = record;
  await withMongo((db) => db.collection("deployments").insertOne({ ...safe }), async () => {});
  json.deployments.push(safe);
  saveJson();
  return record.id;
}

async function updateDeployment(id, patch) {
  const { keyHash, ...safe } = patch;
  const result = await withMongo(
    (db) => db.collection("deployments").updateOne({ id: String(id) }, { $set: safe }),
    () => ({ matchedCount: json.deployments.some((d) => d.id === id) ? 1 : 0 })
  );
  const dep = json.deployments.find((d) => d.id === id);
  if (dep) {
    Object.assign(dep, safe);
    saveJson();
  }
  return Boolean(result && result.matchedCount);
}

async function removeDeployment(id) {
  await withMongo((db) => db.collection("deployments").deleteOne({ id: String(id) }), async () => {});
  json.deployments = json.deployments.filter((d) => d.id !== id);
  saveJsonNow();
}

async function findDeployment(id) {
  return withMongo(
    (db) => db.collection("deployments").findOne({ id: String(id) }),
    () => json.deployments.find((d) => d.id === id) || null
  );
}

async function overview(liveJobs = []) {
  const [tokens, users, deps] = await Promise.all([rawTokens(), listUsers(), listDeployments()]);
  const live = [...liveJobs];
  const pool = await poolStatus();
  const count = (status) => deps.filter((d) => d.status === status).length;
  return {
    users: users.length,
    banned: users.filter((u) => u.banned).length,
    deployments: deps.length + live.filter((j) => j.via === "public" && !deps.some((d) => d.id === j.id)).length,
    running: live.filter((j) => ["queued", "running"].includes(j.status)).length,
    success: count("success"),
    failed: count("failed"),
    publicDeploys: deps.filter((d) => d.via === "public").length,
    ownerDeploys: deps.filter((d) => d.via === "owner").length,
    pool,
    tokens: tokens.map(publicToken),
    recent: deps.slice(0, 12),
    topUsers: users.sort((a, b) => b.deploys - a.deploys).slice(0, 6),
  };
}

/* ---------------- Database URL management ---------------- */

function validMongoUrl(value) {
  return /^mongodb(\+srv)?:\/\/[^\s]+$/i.test(String(value || "").trim());
}

async function addDbUrl({ label, url }) {
  const clean = String(url || "").trim();
  if (!validMongoUrl(clean)) {
    const err = new Error("Use a mongodb:// or mongodb+srv:// connection string.");
    err.status = 400;
    throw err;
  }
  const row = {
    id: newId("db"),
    label: String(label || "").trim().slice(0, 40) || "MongoDB",
    urlEnc: encrypt(clean),
    addedAt: new Date().toISOString(),
  };
  urlRows.push(row);
  saveUrlRows();
  const ok = await connectBest(urlRows.length - 1 + envUrls().length);
  return { ok, status: await dbStatus() };
}

async function removeDbUrl(id) {
  const before = urlRows.length;
  urlRows = urlRows.filter((r) => r.id !== id);
  if (urlRows.length === before) {
    const err = new Error("That MongoDB URL does not exist (env URLs cannot be removed).");
    err.status = 404;
    throw err;
  }
  saveUrlRows();
  await connectBest(0);
  return dbStatus();
}

async function testDbUrl(id) {
  const entry = allUrls().find((u) => u.id === id);
  if (!entry) {
    const err = new Error("Unknown MongoDB URL.");
    err.status = 404;
    throw err;
  }
  try {
    const { client } = await openClient(entry.url);
    await client.close();
    return { ok: true, message: "Connection successful." };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

async function activateDbUrl(id) {
  const urls = allUrls();
  const idx = urls.findIndex((u) => u.id === id);
  if (idx === -1) {
    const err = new Error("Unknown MongoDB URL.");
    err.status = 404;
    throw err;
  }
  const ok = await connectBest(idx);
  return { ok, status: await dbStatus() };
}

async function dbStatus() {
  return {
    mode: mgr.mode,
    activeId: mgr.activeId,
    lastError: mgr.lastError,
    lastCheck: mgr.lastCheck,
    urls: allUrls().map((u) => ({
      id: u.id,
      label: u.label,
      host: maskUrl(u.url),
      fromEnv: u.fromEnv,
      active: u.id === mgr.activeId,
    })),
  };
}

async function init() {
  await connectBest(0);
}

module.exports = {
  init,
  listTokens,
  getTokenSecret,
  addToken,
  updateToken,
  removeToken,
  markTokenError,
  markTokenOk,
  pickToken,
  reserveToken,
  releaseToken,
  poolStatus,
  touchUser,
  getUser,
  setUserBanned,
  removeUser,
  listUsers,
  listDeployments,
  findDeployment,
  addDeployment,
  updateDeployment,
  removeDeployment,
  overview,
  dbStatus,
  addDbUrl,
  removeDbUrl,
  testDbUrl,
  activateDbUrl,
  hashKey: (value) => crypto.createHash("sha256").update(String(value)).digest("hex"),
};
