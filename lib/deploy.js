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
    const child = useNode
      ? spawn(process.execPath, [bin, ...args], {
          cwd,
          env: {
            ...process.env,
            RAILWAY_API_TOKEN: token,
            RAILWAY_TOKEN: token,
            CI: "true",
            NO_COLOR: "1",
            FORCE_COLOR: "0",
          },
          windowsHide: true,
        })
      : spawn(bin, args, {
          cwd,
          env: {
            ...process.env,
            RAILWAY_API_TOKEN: token,
            RAILWAY_TOKEN: token,
            CI: "true",
            NO_COLOR: "1",
            FORCE_COLOR: "0",
          },
          windowsHide: true,
        });

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

async function deployZip(job, { zipPath, projectName, token }) {
  const jobDir = path.join(WORK_DIR, job.id);
  const extractDir = path.join(jobDir, "app");
  fs.mkdirSync(extractDir, { recursive: true });

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

    const startCommand = detectStartCommand(appDir);
    await configureService(job, token, service.id, env.id, startCommand);

    if (!fs.existsSync(path.join(appDir, "Dockerfile"))) {
      jobs.addLog(job, "No Dockerfile found — the build host will auto-detect the stack.", "warn");
    }

    jobs.addLog(job, "Uploading files… (this can take a minute)");
    jobs.setStatus(job, "running", "Uploading source");
    const code = await spawnCli(
      ["up", appDir, "-y", "-c", "-p", project.id, "-e", env.id, "-s", service.id],
      jobDir,
      token,
      job,
      (line, level) => jobs.addLog(job, line, level)
    );
    if (job.cancelRequested) throw new Error("Canceled");
    if (code !== 0) {
      throw new Error(`Deploy engine exited with code ${code}. See logs above.`);
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
    jobs.addLog(job, `Deployment ${deployment.status}: ${job.deploymentUrl || "no public URL yet"}`, "ok");
    jobs.setStatus(job, "success", "Live");
  } finally {
    try {
      fs.rmSync(jobDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(zipPath, { force: true });
    } catch {
      /* ignore */
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

  await configureService(job, token, service.id, env.id, "");

  const deployment = await waitForDeployment(
    job,
    token,
    { projectId: project.id, serviceId: service.id, environmentId: env.id },
    { needsTrigger: true, initialWaitMs: 35000 }
  );

  job.deploymentUrl = deployment.url || deployment.staticUrl || job.deploymentUrl;
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

    if (job.type === "zip") {
      await deployZip(job, { zipPath: job.zipPath, projectName: job.projectName, token });
    } else {
      await deployGithub(job, { repo: job.repo, branch: job.branch, projectName: job.projectName, token });
    }
    job.zipPath = null;
    if (job.tokenId) db.markTokenOk(job.tokenId).catch(() => {});
  } catch (err) {
    if (job.cancelRequested) return;
    jobs.addLog(job, err.message || String(err), "error");
    jobs.setStatus(job, "failed", "Deployment failed");
  }
}

module.exports = { runJob };
