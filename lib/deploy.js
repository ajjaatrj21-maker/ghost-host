const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const rw = require("./railway");
const jobs = require("./jobs");
const db = require("./db");
const { extractZip, detectRoot } = require("./zip");
const { WORK_DIR, DEPLOY_TIMEOUT_MIN, ROOT } = require("./config");

function railwayBin() {
  const base = path.join(ROOT, "node_modules", "@railway", "cli", "bin");
  const candidates =
    process.platform === "win32"
      ? [path.join(base, "railway.exe")]
      : [path.join(base, "railway"), path.join(base, "railway.js")];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "railway";
}

function spawnCli(args, cwd, token, job, onLine) {
  return new Promise((resolve, reject) => {
    const bin = railwayBin();
    const useNode = bin.endsWith(".js");
    const env = {
      ...process.env,
      RAILWAY_API_TOKEN: token,
      CI: "true",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    };
    // RAILWAY_TOKEN makes the CLI treat the value as a project token; account tokens must only use RAILWAY_API_TOKEN.
    delete env.RAILWAY_TOKEN;
    const child = useNode
      ? spawn(process.execPath, [bin, ...args], { cwd, env, windowsHide: true })
      : spawn(bin, args, { cwd, env, windowsHide: true });

    job.child = child;
    let buffer = "";

    const flush = (chunk, level) => {
      buffer += chunk.toString();
      const parts = buffer.split(/\r?\n|\r/);
      buffer = parts.pop();
      for (const line of parts) {
        const clean = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim();
        if (clean) onLine(clean, level);
      }
    };

    child.stdout.on("data", (c) => flush(c, "info"));
    child.stderr.on("data", (c) => flush(c, "warn"));
    child.on("error", (err) => reject(new Error(`Could not start the deploy engine: ${err.message}`)));
    child.on("close", (code) => {
      if (buffer.trim()) onLine(buffer.trim(), "info");
      job.child = null;
      resolve(code);
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function friendlyStatus(status) {
  const map = {
    QUEUED: "Queued in the cloud",
    WAITING: "Waiting for approval",
    BUILDING: "Building image",
    DEPLOYING: "Starting container",
    SUCCESS: "Live and running",
    FAILED: "Build failed",
    CRASHED: "Crashed after start",
    SLEEPING: "Deployed (sleeping)",
    REMOVED: "Removed",
    SKIPPED: "Skipped",
  };
  return map[status] || status;
}

function detectStartCommand(appDir) {
  const has = (file) => fs.existsSync(path.join(appDir, file));
  if (has("Dockerfile") || has("Procfile")) return "";
  if (has("package.json")) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf8"));
      if (pkg.scripts && pkg.scripts.start) return "npm start";
    } catch {
      /* ignore */
    }
  }
  const candidates = [
    ["main.py", "python main.py"],
    ["bot.py", "python bot.py"],
    ["app.py", "python app.py"],
    ["index.js", "node index.js"],
    ["server.js", "node server.js"],
  ];
  for (const [file, cmd] of candidates) {
    if (has(file)) return cmd;
  }
  return "";
}

async function configureService(job, token, serviceId, envId, startCommand) {
  try {
    await rw.updateServiceInstance(token, serviceId, envId, {
      ...(startCommand ? { startCommand } : {}),
      restartPolicyType: "ALWAYS",
    });
    jobs.addLog(
      job,
      `Service set to restart ALWAYS (24/7 keep-alive)${startCommand ? ` · start: ${startCommand}` : ""}.`,
      "ok"
    );
  } catch (err) {
    jobs.addLog(job, `Could not apply service settings: ${err.message}`, "warn");
  }
}

async function waitForDeployment(job, token, ids, { needsTrigger = false, initialWaitMs = 45000 } = {}) {
  const deadline = Date.now() + DEPLOY_TIMEOUT_MIN * 60 * 1000;
  const started = Date.now();
  let lastStatus = "";
  let triggered = !needsTrigger;
  let triggerTries = 0;

  while (Date.now() < deadline) {
    if (job.cancelRequested) throw new Error("Canceled");

    let deployments = [];
    try {
      deployments = await rw.listDeployments(token, { ...ids, first: 5 });
    } catch (err) {
      jobs.addLog(job, `Status check failed: ${err.message}`, "warn");
      await sleep(8000);
      continue;
    }

    if (!deployments.length) {
      if (!triggered && Date.now() - started > initialWaitMs) {
        triggerTries += 1;
        triggered = true;
        jobs.addLog(job, "No deployment detected after repo link — triggering manually…");
        await rw.deployService(token, ids.serviceId, ids.environmentId);
      } else if (triggered && triggerTries < 3 && Date.now() - started > 20000) {
        triggerTries += 1;
        jobs.addLog(job, "Still no deployment — retrying trigger…", "warn");
        await rw.deployService(token, ids.serviceId, ids.environmentId).catch(() => {});
      }
      await sleep(6000);
      continue;
    }

    const latest = deployments[0];
    if (latest.status !== lastStatus) {
      lastStatus = latest.status;
      const url = latest.url || latest.staticUrl || "";
      if (url) job.deploymentUrl = url;
      jobs.addLog(job, `Build status → ${latest.status} (${friendlyStatus(latest.status)})`);
      jobs.setStatus(job, "running", friendlyStatus(latest.status));
    }
    if (latest.url || latest.staticUrl) {
      job.deploymentUrl = latest.url || latest.staticUrl;
      jobs.setStatus(job, "running", friendlyStatus(latest.status));
    }

    if (["SUCCESS", "SLEEPING"].includes(latest.status)) return latest;
    if (["FAILED", "CRASHED", "REMOVED"].includes(latest.status)) {
      throw new Error(`Build finished with status ${latest.status}. Check the build logs.`);
    }

    await sleep(8000);
  }

  throw new Error(`Timed out after ${DEPLOY_TIMEOUT_MIN} minutes waiting for the build host. The deployment may still finish — check back in a minute.`);
}

async function ensurePublicUrl(job, token, ids) {
  if (job.deploymentUrl) return;
  try {
    const domain = await rw.serviceDomainCreate(token, ids);
    if (domain?.domain) {
      job.deploymentUrl = `https://${domain.domain}`;
      jobs.addLog(job, `Public URL generated: ${job.deploymentUrl}`, "ok");
    }
  } catch (err) {
    jobs.addLog(job, `Could not generate the public URL: ${err.message}`, "warn");
  }
}

async function prepareProject(job, token, projectName) {
  jobs.addLog(job, `Creating project "${projectName}"…`);
  const project = await rw.createProject(token, projectName);
  job.projectId = project.id;
  jobs.setStatus(job, "running", "Project created");
  jobs.addLog(job, `Project ready: ${project.name} (${project.id})`, "ok");

  const envs = await rw.getEnvironments(token, project.id);
  const env = envs.find((e) => /^production$/i.test(e.name)) || envs.find((e) => /prod/i.test(e.name)) || envs[0];
  if (!env) throw new Error("The build host did not return an environment for the new project.");
  job.environmentId = env.id;
  jobs.addLog(job, `Environment: ${env.name}`);
  return { project, env };
}

const UPLOAD_ATTEMPTS = 3;
const MAX_TOKEN_SWITCHES = 2;
const WORKSPACE_LIMITED_RE =
  /We limited this workspace|detected unusual activity|Upgrade to a paid plan to lift this restriction/i;

async function uploadSource(job, appDir, token, ids) {
  const args = ["up", "-y", "-c", "-p", ids.projectId, "-e", ids.environmentId, "-s", ids.serviceId];
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
    let transient = false;
    let limited = false;
    const code = await spawnCli(args, appDir, token, job, (line, level) => {
      if (WORKSPACE_LIMITED_RE.test(line)) limited = true;
      if (/Failed to upload code with status code 5\d\d|Failed to create code snapshot/i.test(line)) {
        transient = true;
      }
      jobs.addLog(job, line, level);
    });
    if (job.cancelRequested) return { code: 1, transient: false, limited: false };
    if (code === 0) return { code: 0, transient: false, limited: false };
    if (limited) return { code, transient: false, limited: true };
    if (!transient || attempt === UPLOAD_ATTEMPTS) return { code, transient, limited: false };
    const waitMs = attempt * 6000;
    jobs.addLog(
      job,
      `Cloud upload hiccup (attempt ${attempt}/${UPLOAD_ATTEMPTS}) — retrying in ${waitMs / 1000}s. Your files are safe.`,
      "warn"
    );
    await sleep(waitMs);
    if (job.cancelRequested) return { code: 1, transient: false, limited: false };
  }
  return { code: 1, transient: true, limited: false };
}

async function switchToken(job) {
  if (job.tokenId) {
    await db
      .markTokenError(job.tokenId, "Workspace limited by the hosting side (unusual activity)")
      .catch(() => {});
    await db.releaseToken(job.tokenId, { failed: true }).catch(() => {});
  }
  job.tokenId = "";
  job.tokenLabel = "";
  job.secret = null;
  job.tokenAcquired = false;
  job.tokenReleased = false;
  const picked = await db.pickToken();
  if (!picked) return false;
  job.tokenId = picked.id;
  job.tokenLabel = picked.label;
  job.secret = picked.secret;
  job.tokenAcquired = true;
  jobs.addLog(
    job,
    `This deploy account is limited by the hosting side — switched to another account (${picked.label}).`,
    "warn"
  );
  return true;
}

async function deployZip(job, { zipPath, projectName, token }) {
  const jobDir = path.join(WORK_DIR, job.id);
  const extractDir = path.join(jobDir, "app");
  fs.mkdirSync(extractDir, { recursive: true });
  let preserveZip = false;

  try {
    jobs.addLog(job, "Unpacking your ZIP archive…");
    const count = await extractZip(zipPath, extractDir);
    const appDir = detectRoot(extractDir);
    jobs.addLog(job, `Archive unpacked: ${count} files.`, "ok");

    const { project, env } = await prepareProject(job, token, projectName);

    jobs.addLog(job, "Creating service…");
    const service = await rw.createService(token, { projectId: project.id, name: projectName });
    job.serviceId = service.id;
    jobs.addLog(job, `Service ready: ${service.name} (${service.id})`, "ok");

    if (job.envVars && Object.keys(job.envVars).length) {
      await rw.upsertVariables(token, {
        projectId: project.id,
        environmentId: env.id,
        serviceId: service.id,
        variables: job.envVars,
        skipDeploys: true,
      });
      jobs.addLog(job, `${Object.keys(job.envVars).length} environment variable(s) set.`, "ok");
    }

    const startCommand = detectStartCommand(appDir);
    await configureService(job, token, service.id, env.id, startCommand);

    if (!fs.existsSync(path.join(appDir, "Dockerfile"))) {
      jobs.addLog(job, "No Dockerfile found — the build host will auto-detect the stack.", "warn");
    }

    jobs.addLog(job, "Uploading files… (this can take a minute)");
    jobs.setStatus(job, "running", "Uploading source");
    const result = await uploadSource(job, appDir, token, {
      projectId: project.id,
      environmentId: env.id,
      serviceId: service.id,
    });
    if (job.cancelRequested) throw new Error("Canceled");
    if (result.limited) {
      const err = new Error("The hosting side has limited this deploy account.");
      err.tokenLimited = true;
      throw err;
    }
    if (result.code !== 0) {
      throw new Error(
        result.transient
          ? `The build host's upload endpoint kept returning 500 after ${UPLOAD_ATTEMPTS} tries. That is trouble on their side, not your files — wait a few minutes and press Deploy again.`
          : `Deploy engine exited with code ${result.code}. See logs above.`
      );
    }
    jobs.addLog(job, "Source uploaded. Waiting for the build to finish…", "ok");

    const freshEnvs = await rw.getEnvironments(token, project.id);
    const envId = freshEnvs.find((e) => /^production$/i.test(e.name))?.id || env.id;
    job.environmentId = envId;

    const deployment = await waitForDeployment(job, token, {
      projectId: project.id,
      serviceId: service.id,
      environmentId: envId,
    });

    job.deploymentUrl = deployment.url || deployment.staticUrl || job.deploymentUrl;
    await ensurePublicUrl(job, token, { serviceId: service.id, environmentId: envId });
    jobs.addLog(job, `Deployment ${deployment.status}: ${job.deploymentUrl || "no public URL yet"}`, "ok");
    jobs.setStatus(job, "success", "Live");
  } catch (err) {
    preserveZip = Boolean(err.tokenLimited);
    throw err;
  } finally {
    try {
      fs.rmSync(jobDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    if (!preserveZip) {
      try {
        fs.rmSync(zipPath, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

async function deployGithub(job, { repo, branch, projectName, token }) {
  const { project, env } = await prepareProject(job, token, projectName);

  jobs.addLog(job, `Connecting GitHub repo ${repo}${branch ? ` (branch: ${branch})` : ""}…`);
  const service = await rw.createService(token, {
    projectId: project.id,
    name: projectName,
    repo,
    branch: branch || undefined,
  });
  job.serviceId = service.id;
  jobs.addLog(job, `Service ready: ${service.name} (${service.id})`, "ok");

  if (job.envVars && Object.keys(job.envVars).length) {
    await rw.upsertVariables(token, {
      projectId: project.id,
      environmentId: env.id,
      serviceId: service.id,
      variables: job.envVars,
      skipDeploys: true,
    });
    jobs.addLog(job, `${Object.keys(job.envVars).length} environment variable(s) set.`, "ok");
  }

  await configureService(job, token, service.id, env.id, "");

  const deployment = await waitForDeployment(
    job,
    token,
    { projectId: project.id, serviceId: service.id, environmentId: env.id },
    { needsTrigger: true, initialWaitMs: 35000 }
  );

  job.deploymentUrl = deployment.url || deployment.staticUrl || job.deploymentUrl;
  await ensurePublicUrl(job, token, { serviceId: service.id, environmentId: env.id });
  jobs.addLog(job, `Deployment ${deployment.status}: ${job.deploymentUrl || "no public URL yet"}`, "ok");
  jobs.setStatus(job, "success", "Live");
}

async function runJob(job) {
  const token = job.secret || (await db.getTokenSecret(job.tokenId));
  if (!token) {
    jobs.addLog(job, "Deploy token for this job was removed. Add a token and redeploy.", "error");
    jobs.setStatus(job, "failed", "Token missing");
    return;
  }

  try {
    try {
      await rw.checkToken(token);
      if (job.tokenId) db.markTokenOk(job.tokenId).catch(() => {});
    } catch (err) {
      if (job.tokenId) db.markTokenError(job.tokenId, err.message).catch(() => {});
      jobs.addLog(job, `Deploy token rejected: ${err.message}`, "error");
      jobs.setStatus(job, "failed", "Token invalid");
      return;
    }

    let switches = 0;
    for (;;) {
      try {
        const activeToken = job.secret || token;
        if (job.type === "zip") {
          await deployZip(job, { zipPath: job.zipPath, projectName: job.projectName, token: activeToken });
        } else {
          await deployGithub(job, { repo: job.repo, branch: job.branch, projectName: job.projectName, token: activeToken });
        }
        break;
      } catch (err) {
        if (!err.tokenLimited || job.cancelRequested) throw err;
        if (switches >= MAX_TOKEN_SWITCHES) {
          throw new Error(
            "Every deploy account in the pool is limited by the hosting side. Add a fresh hosting account token from the owner console, then deploy again."
          );
        }
        switches += 1;
        jobs.addLog(job, "Starting over on a fresh account with the same files…", "warn");
        job.projectId = "";
        job.serviceId = "";
        job.environmentId = "";
        const switched = await switchToken(job);
        if (!switched) {
          throw new Error(
            "The hosting side limited this deploy account and no other account is free. Try again in a few minutes or add another token in the owner console."
          );
        }
      }
    }
    job.zipPath = null;
    if (job.tokenId) db.markTokenOk(job.tokenId).catch(() => {});
  } catch (err) {
    if (job.cancelRequested) return;
    if (job.type === "zip" && job.zipPath) {
      try {
        fs.rmSync(job.zipPath, { force: true });
      } catch {
        /* ignore */
      }
      job.zipPath = null;
    }
    jobs.addLog(job, err.message || String(err), "error");
    jobs.setStatus(job, "failed", "Deployment failed");
  }
}

module.exports = { runJob };
