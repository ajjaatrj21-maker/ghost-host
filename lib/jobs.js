const crypto = require("crypto");
const db = require("./db");
const config = require("./config");

const jobs = new Map();
const MAX_LOGS = 1500;
const MAX_RUNNING = config.MAX_RUNNING;
const queue = [];
let pumping = false;

function createJob({
  type,
  name,
  projectName,
  preferredTokenId,
  zipPath,
  repo,
  branch,
  via = "owner",
  userKey = "",
  userName = "",
}) {
  const id = `job_${crypto.randomBytes(6).toString("hex")}`;
  const accessKey = crypto.randomBytes(16).toString("hex");
  const job = {
    id,
    type,
    name,
    projectName,
    preferredTokenId: preferredTokenId || "",
    tokenId: "",
    tokenLabel: "",
    secret: null,
    tokenAcquired: false,
    tokenReleased: false,
    via,
    userKey,
    userName,
    accessKey,
    accessHash: db.hashKey(accessKey),
    zipPath: zipPath || null,
    repo: repo || "",
    branch: branch || "",
    status: "queued",
    stage: "Waiting in queue",
    logs: [],
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    deploymentUrl: "",
    projectId: "",
    serviceId: "",
    environmentId: "",
    cancelRequested: false,
    subscribers: new Set(),
    child: null,
  };
  jobs.set(id, job);
  queue.push(job);
  db.addDeployment(record(job)).catch(() => {});
  pump();
  return job;
}

function publicJob(job) {
  return {
    id: job.id,
    type: job.type,
    name: job.name,
    projectName: job.projectName,
    tokenId: job.tokenId || "",
    tokenLabel: job.tokenLabel,
    status: job.status,
    stage: job.stage,
    via: job.via,
    free: job.via === "public",
    userName: job.userName || "",
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    deploymentUrl: job.deploymentUrl,
    projectId: job.projectId,
    serviceId: job.serviceId,
    environmentId: job.environmentId,
  };
}

function record(job) {
  return {
    ...publicJob(job),
    userKey: job.userKey,
    accessHash: job.accessHash,
    logs: job.logs.slice(-250),
  };
}

function emit(job, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of job.subscribers) {
    try {
      res.write(payload);
    } catch {
      job.subscribers.delete(res);
    }
  }
}

function addLog(job, message, level = "info") {
  const line = {
    t: new Date().toISOString(),
    level,
    message: String(message).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trimEnd(),
  };
  if (!line.message) return;
  job.logs.push(line);
  if (job.logs.length > MAX_LOGS) job.logs.splice(0, job.logs.length - MAX_LOGS);
  emit(job, "log", line);
}

function releaseSlot(job) {
  if (!job.tokenAcquired || job.tokenReleased) return;
  job.tokenReleased = true;
  db.releaseToken(job.tokenId, { failed: ["failed", "canceled", "interrupted"].includes(job.status) }).catch(() => {});
}

function setStatus(job, status, stage) {
  job.status = status;
  if (stage) job.stage = stage;
  if (status === "running" && !job.startedAt) job.startedAt = new Date().toISOString();
  if (["success", "failed", "canceled", "interrupted"].includes(status)) {
    job.finishedAt = new Date().toISOString();
    releaseSlot(job);
  }
  emit(job, "status", publicJob(job));
  db.updateDeployment(job.id, record(job))
    .then((ok) => (ok ? null : db.addDeployment(record(job))))
    .catch((err) => console.error("Failed to persist deployment:", err.message));
}

function stream(job, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`event: init\ndata: ${JSON.stringify({ ...publicJob(job), logs: job.logs })}\n\n`);
  job.subscribers.add(res);

  const heartbeat = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      /* ignore */
    }
  }, 15000);

  const cleanup = () => {
    clearInterval(heartbeat);
    job.subscribers.delete(res);
  };
  res.on("close", cleanup);
  res.on("error", cleanup);
}

function cancelJob(job) {
  if (["success", "failed", "canceled"].includes(job.status)) return false;
  job.cancelRequested = true;
  if (job.child) {
    try {
      if (process.platform === "win32") {
        require("child_process").execSync(`taskkill /pid ${job.child.pid} /T /F`, {
          stdio: "ignore",
          windowsHide: true,
        });
      } else {
        job.child.kill("SIGKILL");
      }
    } catch {
      /* ignore */
    }
  }
  setStatus(job, "canceled", "Canceled");
  addLog(job, "Deployment canceled.", "warn");
  return true;
}

let runner = null;
function setRunner(fn) {
  runner = fn;
  pump();
}

async function pump() {
  if (pumping || !runner) return;
  pumping = true;
  try {
    for (;;) {
      const running = [...jobs.values()].filter((j) => j.status === "running").length;
      if (running >= MAX_RUNNING) break;
      const job = queue.shift();
      if (!job) break;
      if (job.cancelRequested || job.status !== "queued") continue;

      addLog(job, "Assigning a deploy slot from the pool…");
      const picked = job.preferredTokenId
        ? await db.reserveToken(job.preferredTokenId)
        : await db.pickToken();
      if (!picked) {
        addLog(job, "Every deploy token in the pool is busy right now. Try again in a few minutes.", "error");
        setStatus(job, "failed", "No free token slot");
        continue;
      }
      job.preferredTokenId = "";
      job.tokenId = picked.id;
      job.tokenLabel = picked.label;
      job.secret = picked.secret;
      job.tokenAcquired = true;
      addLog(job, `Slot ready · using ${picked.label}.`, "ok");
      setStatus(job, "running", "Starting deployment");
      runner(job).catch((err) => {
        addLog(job, err.message || String(err), "error");
        setStatus(job, "failed", "Deployment failed");
      });
    }
  } finally {
    pumping = false;
  }
}

setInterval(() => {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.finishedAt && new Date(job.finishedAt).getTime() < cutoff && !job.subscribers.size) {
      jobs.delete(id);
    }
  }
}, 30 * 60 * 1000).unref?.();

async function recover() {
  try {
    const rows = await db.listDeployments();
    for (const dep of rows) {
      if (["queued", "running"].includes(dep.status)) {
        await db.updateDeployment(dep.id, {
          status: "interrupted",
          stage: "Panel restarted during deployment",
          finishedAt: new Date().toISOString(),
        });
        if (dep.tokenId) await db.releaseToken(dep.tokenId, { failed: true });
      }
    }
  } catch (err) {
    console.error("Recovery failed:", err.message);
  }
}

function activeFor(userKey) {
  return [...jobs.values()].filter(
    (j) => j.userKey === userKey && ["queued", "running"].includes(j.status)
  ).length;
}

module.exports = {
  createJob,
  addLog,
  setStatus,
  stream,
  cancelJob,
  setRunner,
  pump,
  jobs,
  publicJob,
  recover,
  activeFor,
};
