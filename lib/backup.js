const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DATA_DIR } = require("./config");
const { encrypt, decrypt } = require("./vault");

const DB_FILE = path.join(DATA_DIR, "db.json");
const URL_FILE = path.join(DATA_DIR, "databases.json");
const REMOTE_URL =
  process.env.STATE_BACKUP_URL ||
  "https://raw.githubusercontent.com/ajjaatrj21-maker/ghost-host/backup/backup.json";

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function counts() {
  let parsed = {};
  try {
    parsed = JSON.parse(readText(DB_FILE));
  } catch {
    /* empty or corrupt snapshot */
  }
  let urlCount = 0;
  try {
    urlCount = (JSON.parse(readText(URL_FILE)).urls || []).length;
  } catch {
    /* no url file */
  }
  const tokens = Array.isArray(parsed.tokens) ? parsed.tokens.length : 0;
  const deployments = Array.isArray(parsed.deployments) ? parsed.deployments.length : 0;
  const users = Array.isArray(parsed.users) ? parsed.users.length : 0;
  return {
    tokens,
    deployments,
    users,
    urlCount,
    empty: tokens + deployments + users + urlCount === 0,
  };
}

function sealState() {
  const db = readText(DB_FILE);
  const urls = readText(URL_FILE);
  const facts = counts();
  const hash = crypto.createHash("sha256").update(`${db}\u0000${urls}`).digest("hex");
  const blob = encrypt(JSON.stringify({ v: 1, at: new Date().toISOString(), db, urls }));
  return { ...facts, hash, blob };
}

function writeState(file, text) {
  if (!text) return;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

async function restoreIfEmpty() {
  if (!counts().empty) return false;
  let payload;
  try {
    const res = await fetch(REMOTE_URL, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return false;
    payload = await res.json();
  } catch {
    return false;
  }
  if (!payload || !payload.blob) return false;
  let state;
  try {
    state = JSON.parse(decrypt(payload.blob));
  } catch {
    console.warn("Saved state exists but cannot be decrypted with the current APP_SECRET.");
    return false;
  }
  if (!counts().empty) return false;
  writeState(DB_FILE, typeof state.db === "string" ? state.db : "");
  writeState(URL_FILE, typeof state.urls === "string" ? state.urls : "");
  console.log("  Restored saved panel state from the encrypted backup.");
  return true;
}

module.exports = { sealState, restoreIfEmpty };
