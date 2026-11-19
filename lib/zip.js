const fs = require("fs");
const path = require("path");
const unzipper = require("unzipper");
const config = require("./config");

const MAX_ENTRIES = config.MAX_ENTRIES;
const MAX_TOTAL_BYTES = config.MAX_EXTRACT_GB * 1024 * 1024 * 1024;

function safeJoin(dest, entryPath) {
  const normalized = entryPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const target = path.resolve(dest, normalized);
  const rel = path.relative(dest, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return target;
}

async function extractZip(zipPath, dest) {
  const directory = await unzipper.Open.file(zipPath);
  fs.mkdirSync(dest, { recursive: true });

  if (directory.files.length > MAX_ENTRIES) {
    throw new Error(`ZIP has too many entries (${directory.files.length}). Max ${MAX_ENTRIES}.`);
  }

  let total = 0;
  let written = 0;

  for (const entry of directory.files) {
    total += entry.uncompressedSize || 0;
    if (total > MAX_TOTAL_BYTES) {
      throw new Error(`ZIP expands beyond ${config.MAX_EXTRACT_GB} GB. Please slim it down.`);
    }

    const target = safeJoin(dest, entry.path);
    if (!target) continue;

    if (/\/$/.test(entry.path) || entry.type === "Directory") {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    await new Promise((resolve, reject) => {
      const source = entry.stream();
      const sink = fs.createWriteStream(target);
      source.on("error", reject);
      sink.on("error", reject);
      sink.on("finish", resolve);
      source.pipe(sink);
    });
    written += 1;
  }

  if (!written) throw new Error("ZIP looks empty — no files found inside.");
  return written;
}

function detectRoot(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const visible = entries.filter((e) => e.name !== "__MACOSX" && e.name !== ".DS_Store");
  if (visible.length === 1 && visible[0].isDirectory()) {
    return path.join(dir, visible[0].name);
  }
  return dir;
}

module.exports = { extractZip, detectRoot };
