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

function friendlyZipError(err) {
  const raw = String(err?.message || err || "");
  if (
    /FILE_ENDED|unexpected end|end of central|central directory|invalid|corrupt|bad zip|signature|compression method|no such file|ENOENT/i.test(
      raw
    )
  ) {
    return new Error(
      "This ZIP looks broken or incomplete. Re-create it (right-click the folder → Send to → Compressed (zipped) folder) and upload again."
    );
  }
  return err;
}

function sniffArchive(zipPath) {
  let fd;
  const buf = Buffer.alloc(512);
  let n = 0;
  try {
    fd = fs.openSync(zipPath, "r");
    n = fs.readSync(fd, buf, 0, 512, 0);
  } catch {
    return "";
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  if (n < 4) return "";
  const hex = buf.subarray(0, 6).toString("hex");
  if (hex.startsWith("504b")) return "";
  if (hex.startsWith("1f8b")) return "This is a .gz file, not a ZIP. Create a real .zip archive and upload it.";
  if (buf.subarray(0, 4).toString() === "Rar!") return "This is a .rar file, not a ZIP. Create a real .zip archive and upload it.";
  if (hex.startsWith("377abcaf271c")) return "This is a .7z file, not a ZIP. Create a real .zip archive and upload it.";
  if (n >= 262 && buf.subarray(257, 262).toString() === "ustar") {
    return "This is a .tar file renamed to .zip. Create a real .zip archive (right-click the folder → Send to → Compressed (zipped) folder).";
  }
  return "";
}

async function openZip(zipPath) {
  const hint = sniffArchive(zipPath);
  if (hint) throw new Error(hint);
  try {
    return await unzipper.Open.file(zipPath);
  } catch (err) {
    throw friendlyZipError(err);
  }
}

async function probeZip(zipPath) {
  const directory = await openZip(zipPath);
  if (!directory.files.length) throw new Error("This ZIP is empty. Zip your project folder and upload again.");
  if (directory.files.length > MAX_ENTRIES) {
    throw new Error(`ZIP has too many entries (${directory.files.length}). Max ${MAX_ENTRIES}.`);
  }
  const files = directory.files.filter((entry) => !/\/$/.test(entry.path) && entry.type !== "Directory");
  if (!files.length) throw new Error("This ZIP has no files inside. Zip your project folder and upload again.");
  const encrypted = files.find((entry) => {
    const flags = entry.flags ?? entry.vars?.flags ?? 0;
    return (flags & 1) === 1;
  });
  if (encrypted) throw new Error("This ZIP is password-protected. Remove the password and upload again.");
  return { entries: directory.files.length, files: files.length };
}

async function extractZip(zipPath, dest) {
  const directory = await openZip(zipPath);
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
      source.on("error", (err) => reject(friendlyZipError(err)));
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

module.exports = { extractZip, detectRoot, probeZip };
