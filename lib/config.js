require("dotenv").config();
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const UPLOAD_DIR = path.join(ROOT, "uploads");
const WORK_DIR = path.join(ROOT, "work");

for (const dir of [DATA_DIR, UPLOAD_DIR, WORK_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

function secret() {
  if (process.env.APP_SECRET && process.env.APP_SECRET.length >= 16) {
    return process.env.APP_SECRET;
  }
  const file = path.join(DATA_DIR, ".secret");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  const generated = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, generated, { mode: 0o600 });
  return generated;
}

const pkg = require(path.join(ROOT, "package.json"));

module.exports = {
  ROOT,
  DATA_DIR,
  UPLOAD_DIR,
  WORK_DIR,
  PORT: Number(process.env.PORT || 3000),
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || "owner",
  APP_SECRET: secret(),
  MAX_ZIP_MB: Number(process.env.MAX_ZIP_MB || 1024),
  MAX_ENTRIES: Number(process.env.MAX_ENTRIES || 20000),
  MAX_EXTRACT_GB: Number(process.env.MAX_EXTRACT_GB || 4),
  DEPLOY_TIMEOUT_MIN: Number(process.env.DEPLOY_TIMEOUT_MIN || 25),
  MAX_RUNNING: Number(process.env.MAX_RUNNING || 2),
  PUBLIC_DEPLOYS_PER_HOUR: Number(process.env.PUBLIC_DEPLOYS_PER_HOUR || 8),
  PUBLIC_ACTIVE_JOBS: Number(process.env.PUBLIC_ACTIVE_JOBS || 2),
  VERSION: pkg.version,
};
