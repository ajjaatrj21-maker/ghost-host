const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  session: null,
  meta: null,
  publicStatus: null,
  deployType: "zip",
  file: null,
  key: null,
  jobId: null,
  es: null,
  owner: {
    view: "site",
    tab: "overview",
    tokens: [],
    pool: null,
    jobs: [],
    users: [],
    overview: null,
    filter: "all",
    query: "",
    expanded: new Set(),
    type: "zip",
    file: null,
    es: null,
    jobId: null,
    db: null,
    projects: [],
  },
};

/* ---------------- helpers ---------------- */

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

const appHref = (id) => `/go/${encodeURIComponent(String(id))}/`;

function timeAgo(iso) {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return "—";
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function fmtBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function statusPill(status) {
  const cls = ["success", "failed", "canceled", "interrupted", "running", "queued"].includes(status) ? status : "";
  const label = status === "interrupted" ? "interrupted" : status || "queued";
  return `<span class="status ${cls}"><i></i>${esc(label)}</span>`;
}

function initials(name) {
  const text = String(name || "")
    .split(/\s+/)
    .map((part) => part[0] || "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return text || "G";
}

let toastTimer = null;
function toast(message, bad = false) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.toggle("bad", bad);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

async function api(path, { method = "GET", body, form } = {}) {
  const options = { method, headers: {} };
  if (form) {
    options.body = form;
  } else if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const res = await fetch(path, options);
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    if (res.status === 401) handleUnauthorized();
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function handleUnauthorized() {
  if (state.owner.view === "console") {
    closeConsole();
    showLogin("Session expired. Sign in again.");
  }
}

/* ---------------- terminal ---------------- */

const TERM_LIMIT = 900;

function termLine(el, line) {
  const row = document.createElement("div");
  row.className = "ln";
  const time = new Date(line.t || Date.now()).toLocaleTimeString([], { hour12: false });
  row.innerHTML = `<span class="t">${esc(time)}</span><span class="l-${esc(line.level || "info")}">${esc(line.message || "")}</span>`;
  el.appendChild(row);
  while (el.children.length > TERM_LIMIT) el.removeChild(el.firstChild);
  const auto = $("#autoscroll");
  if (!auto || auto.checked) el.scrollTop = el.scrollHeight;
}

function termNote(el, text) {
  const row = document.createElement("div");
  row.className = "ln";
  row.innerHTML = `<span class="l-sys">${esc(text)}</span>`;
  el.appendChild(row);
  el.scrollTop = el.scrollHeight;
}

/* ---------------- public site ---------------- */

function setPoolUI(pool) {
  if (!pool) return;
  const free = pool.free || 0;
  const pill = $("#pool-pill");
  pill.classList.toggle("off", free === 0);
  $("#pool-free").textContent = free;
  const cPill = $("#c-pool-pill");
  if (cPill) {
    cPill.classList.toggle("off", free === 0);
    $("#c-pool-free").textContent = free;
  }
  const chip = $("#slot-chip");
  chip.classList.toggle("off", free === 0);
  $("#slot-chip-text").textContent =
    free > 0 ? `${free} slot${free === 1 ? "" : "s"} free` : pool.tokens === 0 ? "pool has no tokens" : "all slots busy";
  $("#stat-slots").textContent = free;
  const btn = $("#btn-deploy");
  if (btn && !btn.dataset.busy) {
    btn.disabled = free === 0;
    btn.style.opacity = free === 0 ? "0.55" : "";
  }
  $("#deploy-limit").textContent = state.meta
    ? `Limit: ${state.meta.publicLimitPerHour} deploys per hour · builds time out at ${state.meta.deployTimeoutMin} min.`
    : "";
}

async function loadPublic() {
  try {
    const data = await api("/api/public/status");
    state.publicStatus = data;
    setPoolUI(data.pool);
    $("#stat-deploys").textContent = data.stats.deploys;
    $("#stat-builders").textContent = data.stats.builders;
    $("#stat-live").textContent = data.stats.live;
    renderRecent(data.recent || []);
  } catch {
    /* keep last known numbers */
  }
}

function renderRecent(rows) {
  const wrap = $("#recent-list");
  const empty = $("#recent-empty");
  if (!rows.length) {
    wrap.innerHTML = "";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  wrap.innerHTML = rows
    .map(
      (row) => `
      <div class="build-row">
        <span class="name">${esc(row.name)}</span>
        <span class="muted">${esc(row.user || "Guest")}</span>
        <span class="mono">${row.type === "github" ? "GitHub" : "ZIP"}</span>
        ${statusPill(row.status)}
        <span class="when">${esc(timeAgo(row.createdAt))}</span>
      </div>`
    )
    .join("");
}

function setDeployType(type) {
  state.deployType = type;
  $$(".seg-btn[data-type]").forEach((btn) => {
    const active = btn.dataset.type === type;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", String(active));
  });
  $$("[data-pane]").forEach((pane) => {
    pane.hidden = pane.dataset.pane !== type;
  });
}

function setPublicFile(file) {
  state.file = file || null;
  const meta = $("#file-meta");
  const drop = $("#dz");
  if (!state.file) {
    meta.hidden = true;
    drop.hidden = false;
    return;
  }
  $("#file-name").textContent = state.file.name;
  $("#file-size").textContent = fmtBytes(state.file.size);
  meta.hidden = false;
  drop.hidden = true;
  const project = $("#deploy-project");
  if (!project.value.trim()) {
    project.value = state.file.name.replace(/\.zip$/i, "").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60);
  }
}

function bindDropzone({ zone, input, onPick, onClear }) {
  const dz = $(zone);
  const fileInput = $(input);
  dz.addEventListener("click", () => fileInput.click());
  dz.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      fileInput.click();
    }
  });
  ["dragenter", "dragover"].forEach((name) =>
    dz.addEventListener(name, (event) => {
      event.preventDefault();
      dz.classList.add("is-over");
    })
  );
  ["dragleave", "drop"].forEach((name) =>
    dz.addEventListener(name, (event) => {
      event.preventDefault();
      dz.classList.remove("is-over");
    })
  );
  dz.addEventListener("drop", (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) onPick(file);
  });
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) onPick(file);
  });
  return { onClear };
}

function wirePublic() {
  $$(".seg-btn[data-type]").forEach((btn) =>
    btn.addEventListener("click", () => setDeployType(btn.dataset.type))
  );

  bindDropzone({
    zone: "#dz",
    input: "#file",
    onPick: (file) => {
      if (!/\.zip$/i.test(file.name)) {
        $("#deploy-error").textContent = "Only .zip archives are accepted.";
        return;
      }
      $("#deploy-error").textContent = "";
      setPublicFile(file);
    },
  });
  $("#file-remove").addEventListener("click", () => {
    setPublicFile(null);
    $("#file").value = "";
  });

  $("#gh-repo").addEventListener("input", () => {
    const project = $("#deploy-project");
    if (!project.value.trim()) {
      const raw = $("#gh-repo").value.trim().replace(/^https?:\/\/[^/]+\//, "");
      const repo = raw.split("/")[1] || "";
      if (repo) project.value = repo.replace(/\.git$/i, "").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60);
    }
  });

  const stored = localStorage.getItem("ghost_name");
  if (stored) $("#deploy-name").value = stored;

  $("#btn-deploy").addEventListener("click", startPublicDeploy);
  $("#btn-stop").addEventListener("click", () => stopPublicJob());
  $("#btn-refresh-recent").addEventListener("click", loadPublic);
  $("#btn-console").addEventListener("click", () => {
    if (state.session?.authed) openConsole();
    else showLogin();
  });
}

async function startPublicDeploy() {
  const error = $("#deploy-error");
  error.textContent = "";
  const name = $("#deploy-name").value.trim();
  if (name.length < 2) {
    error.textContent = "Enter your name (at least 2 characters) so the owner knows who deployed.";
    $("#deploy-name").focus();
    return;
  }
  const projectName = $("#deploy-project").value.trim();
  if (!projectName) {
    error.textContent = "Give the project a name.";
    $("#deploy-project").focus();
    return;
  }
  if (state.deployType === "zip" && !state.file) {
    error.textContent = "Choose a .zip file first.";
    return;
  }
  if (state.deployType === "github" && !$("#gh-repo").value.trim()) {
    error.textContent = "Paste a GitHub repository.";
    return;
  }

  localStorage.setItem("ghost_name", name);
  const button = $("#btn-deploy");
  button.disabled = true;
  button.dataset.busy = "1";
  button.textContent = state.deployType === "zip" ? "Uploading…" : "Starting…";

  try {
    let data;
    if (state.deployType === "zip") {
      const form = new FormData();
      form.append("file", state.file);
      form.append("projectName", projectName);
      form.append("username", name);
      form.append("env", $("#deploy-env").value);
      data = await api("/api/public/deploy/zip", { method: "POST", form });
    } else {
      data = await api("/api/public/deploy/github", {
        method: "POST",
        body: {
          projectName,
          username: name,
          repo: $("#gh-repo").value.trim(),
          branch: $("#gh-branch").value.trim(),
          env: $("#deploy-env").value,
        },
      });
    }
    state.key = data.key;
    openLiveJob(data.job);
    loadPublic();
  } catch (err) {
    error.textContent = err.message;
    if (err.status === 503) toast("All slots busy — try again in a few minutes.", true);
  } finally {
    delete button.dataset.busy;
    button.disabled = false;
    button.textContent = "Deploy now";
  }
}

function openLiveJob(job) {
  state.jobId = job.id;
  $("#live").hidden = false;
  $("#live-project").textContent = job.projectName || job.name;
  $("#live-id").textContent = job.id;
  $("#live-term").innerHTML = "";
  $("#btn-stop").hidden = false;
  $("#live-url").hidden = true;
  $("#live").scrollIntoView({ behavior: "smooth", block: "start" });
  applyLiveStatus(job);
  subscribePublic(job.id);
}

function applyLiveStatus(job) {
  const dot = $("#live-dot");
  dot.className = `status-dot ${job.status || ""}`;
  $("#live-stage").textContent = job.stage || job.status || "Queued";
  const url = job.deploymentUrl;
  if (url) {
    $("#live-url").href = appHref(job.id);
    $("#live-url").hidden = false;
  }
  const done = ["success", "failed", "canceled", "interrupted"].includes(job.status);
  $("#btn-stop").hidden = done;
  if (done) {
    setTimeout(loadPublic, 400);
  }
}

function subscribePublic(id) {
  if (state.es) state.es.close();
  const query = state.key ? `?key=${encodeURIComponent(state.key)}` : "";
  const es = new EventSource(`/api/public/jobs/${id}/stream${query}`);
  state.es = es;
  const term = $("#live-term");

  es.addEventListener("init", (event) => {
    const data = JSON.parse(event.data);
    term.innerHTML = "";
    (data.logs || []).forEach((line) => termLine(term, line));
    if (!data.logs?.length) termNote(term, "Connected. Waiting for the first build line…");
    applyLiveStatus(data);
  });
  es.addEventListener("log", (event) => termLine(term, JSON.parse(event.data)));
  es.addEventListener("status", (event) => {
    const job = JSON.parse(event.data);
    applyLiveStatus(job);
    if (["success", "failed", "canceled", "interrupted"].includes(job.status)) {
      es.close();
      if (state.es === es) state.es = null;
      refreshMyJobs();
    }
  });
  es.onerror = () => {
    es.close();
    if (state.es === es) state.es = null;
  };
}

async function stopPublicJob() {
  if (!state.jobId) return;
  try {
    await api(`/api/public/jobs/${state.jobId}/cancel`, {
      method: "POST",
      body: { key: state.key || "" },
    });
  } catch (err) {
    toast(err.message, true);
  }
}

async function refreshMyJobs() {
  try {
    const data = await api("/api/public/my");
    if (data.user?.name) $("#deploy-name").value = data.user.name;
  } catch {
    /* ignore */
  }
}

/* ---------------- owner: console shell ---------------- */

function setView(view) {
  const consoleEl = $("#console");
  const site = $("#site");
  if (view === "console") {
    site.hidden = true;
    consoleEl.hidden = false;
    document.body.classList.add("console-view");
    window.scrollTo({ top: 0 });
  } else {
    consoleEl.hidden = true;
    site.hidden = false;
    document.body.classList.remove("console-view");
  }
  state.owner.view = view;
}

function openConsole() {
  setView("console");
  if (location.hash !== "#/console") history.replaceState(null, "", "#/console");
  switchTab("overview");
}

function closeConsole() {
  setView("site");
  if (location.hash === "#/console") history.replaceState(null, "", "#");
  if (state.owner.es) {
    state.owner.es.close();
    state.owner.es = null;
  }
}

function switchTab(tab) {
  state.owner.tab = tab;
  $$(".ctab").forEach((btn) => btn.classList.toggle("is-active", btn.dataset.tab === tab));
  $$(".panel").forEach((panel) => panel.classList.toggle("is-active", panel.dataset.panel === tab));
  if (tab === "overview") loadOverview();
  if (tab === "deploy") loadDeployTokens();
  if (tab === "tokens") loadTokens();
  if (tab === "users") loadUsers();
  if (tab === "deployments") loadJobs();
  if (tab === "database") loadDb();
}

function wireConsole() {
  $$(".ctab").forEach((btn) => btn.addEventListener("click", () => switchTab(btn.dataset.tab)));
  $("#btn-back").addEventListener("click", closeConsole);
  $("#btn-logout").addEventListener("click", async () => {
    await fetch("/api/logout", { method: "POST" });
    state.session = { authed: false };
    closeConsole();
    toast("Signed out.");
  });
  $("#btn-refresh-ov").addEventListener("click", loadOverview);
  $("#btn-refresh-tokens").addEventListener("click", loadTokens);
  $("#btn-refresh-users").addEventListener("click", loadUsers);
  $("#btn-refresh-jobs").addEventListener("click", loadJobs);
  $("#btn-refresh-db").addEventListener("click", loadDb);

  $$("[data-goto]").forEach((btn) =>
    btn.addEventListener("click", () => switchTab(btn.dataset.goto))
  );

  $("#user-search").addEventListener("input", (event) => {
    state.owner.query = event.target.value.trim().toLowerCase();
    renderUsers();
  });

  $$("#job-filters .filter").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.owner.filter = btn.dataset.filter;
      $$("#job-filters .filter").forEach((other) => other.classList.toggle("is-active", other === btn));
      renderJobs();
    })
  );

  /* owner deploy */
  $$(".seg-btn[data-c-type]").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.owner.type = btn.dataset.cType;
      $$(".seg-btn[data-c-type]").forEach((other) => other.classList.toggle("is-active", other === btn));
      $$("[data-c-pane]").forEach((pane) => (pane.hidden = pane.dataset.cPane !== state.owner.type));
    })
  );
  bindDropzone({
    zone: "#cdz",
    input: "#c-file",
    onPick: (file) => {
      if (!/\.zip$/i.test(file.name)) {
        $("#c-deploy-error").textContent = "Only .zip archives are accepted.";
        return;
      }
      state.owner.file = file;
      $("#c-file-name").textContent = file.name;
      $("#c-file-size").textContent = fmtBytes(file.size);
      $("#c-file-meta").hidden = false;
      $("#cdz").hidden = true;
      if (!$("#c-deploy-project").value.trim()) {
        $("#c-deploy-project").value = file.name.replace(/\.zip$/i, "").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60);
      }
    },
  });
  $("#c-file-remove").addEventListener("click", () => {
    state.owner.file = null;
    $("#c-file-meta").hidden = true;
    $("#cdz").hidden = false;
    $("#c-file").value = "";
  });
  $("#c-gh-repo").addEventListener("input", () => {
    const target = $("#c-deploy-project");
    if (target.value.trim()) return;
    const repo = $("#c-gh-repo").value.trim().replace(/^https?:\/\/[^/]+\//, "").split("/")[1] || "";
    if (repo) target.value = repo.replace(/\.git$/i, "").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60);
  });
  $("#form-owner-deploy").addEventListener("submit", startOwnerDeploy);
  $("#c-stop").addEventListener("click", stopOwnerJob);

  /* token form */
  $("#form-add-token").addEventListener("submit", addToken);
  $("#btn-load-projects").addEventListener("click", loadProjects);
  $("#form-db-url").addEventListener("submit", addDbUrl);

  $("#log-close").addEventListener("click", () => {
    closeLogStream();
    $("#log-modal").close();
  });
  $("#vars-close").addEventListener("click", () => $("#vars-modal").close());
  $("#vars-cancel").addEventListener("click", () => $("#vars-modal").close());
  $("#vars-save").addEventListener("click", saveVars);
}

async function startOwnerDeploy(event) {
  event.preventDefault();
  const error = $("#c-deploy-error");
  error.textContent = "";
  const projectName = $("#c-deploy-project").value.trim();
  if (!projectName) {
    error.textContent = "Project name is required.";
    return;
  }
  if (state.owner.type === "zip" && !state.owner.file) {
    error.textContent = "Choose a .zip file.";
    return;
  }
  if (state.owner.type === "github" && !$("#c-gh-repo").value.trim()) {
    error.textContent = "Repository is required.";
    return;
  }
  const button = $("#form-owner-deploy button[type=submit]");
  button.disabled = true;

  try {
    let data;
    if (state.owner.type === "zip") {
      const form = new FormData();
      form.append("file", state.owner.file);
      form.append("projectName", projectName);
      form.append("env", $("#c-deploy-env").value);
      data = await api("/api/deploy/zip", { method: "POST", form });
    } else {
      data = await api("/api/deploy/github", {
        method: "POST",
        body: {
          projectName,
          repo: $("#c-gh-repo").value.trim(),
          branch: $("#c-gh-branch").value.trim(),
          env: $("#c-deploy-env").value,
        },
      });
    }
    state.owner.file = null;
    $("#c-file-remove").click();
    openOwnerJob(data.job);
    loadOverview();
  } catch (err) {
    error.textContent = err.message;
  } finally {
    button.disabled = false;
  }
}

function openOwnerJob(job) {
  state.owner.jobId = job.id;
  $("#c-live-project").textContent = job.projectName || job.name;
  $("#c-live-stage").textContent = job.stage || "Queued";
  $("#c-live-term").innerHTML = "";
  $("#c-stop").hidden = false;
  $("#c-live-url").hidden = true;
  $("#c-live-dot").className = `status-dot ${job.status || ""}`;
  subscribeOwner(job.id);
}

function applyOwnerStatus(job) {
  $("#c-live-dot").className = `status-dot ${job.status || ""}`;
  $("#c-live-stage").textContent = job.stage || job.status;
  if (job.deploymentUrl) {
    $("#c-live-url").href = appHref(job.id);
    $("#c-live-url").hidden = false;
  }
  const done = ["success", "failed", "canceled", "interrupted"].includes(job.status);
  $("#c-stop").hidden = done;
}

function subscribeOwner(id) {
  if (state.owner.es) state.owner.es.close();
  const es = new EventSource(`/api/jobs/${id}/stream`);
  state.owner.es = es;
  const term = $("#c-live-term");
  es.addEventListener("init", (event) => {
    const data = JSON.parse(event.data);
    term.innerHTML = "";
    (data.logs || []).forEach((line) => termLine(term, line));
    applyOwnerStatus(data);
  });
  es.addEventListener("log", (event) => termLine(term, JSON.parse(event.data)));
  es.addEventListener("status", (event) => {
    const job = JSON.parse(event.data);
    applyOwnerStatus(job);
    if (["success", "failed", "canceled", "interrupted"].includes(job.status)) {
      es.close();
      if (state.owner.es === es) state.owner.es = null;
      loadOverview();
      if (state.owner.tab === "deployments") loadJobs();
    }
  });
}

async function stopOwnerJob() {
  if (!state.owner.jobId) return;
  try {
    await api(`/api/jobs/${state.owner.jobId}/cancel`, { method: "POST" });
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------- owner: overview ---------------- */

async function loadOverview() {
  try {
    const data = await api("/api/overview");
    state.owner.overview = data;
    state.owner.pool = data.pool;
    $("#ov-builders").textContent = data.users;
    $("#ov-deploys").textContent = data.deployments;
    $("#ov-running").textContent = data.running;
    $("#ov-slots").textContent = data.pool.free;
    $("#ov-slots-note").textContent = `of ${data.pool.capacity} capacity`;
    $("#ov-pool-chip").textContent = `${data.pool.active}/${data.tokens.length} active`;

    const poolList = $("#ov-pool");
    const poolEmpty = $("#ov-pool-empty");
    if (!data.tokens.length) {
      poolList.innerHTML = "";
      poolEmpty.hidden = false;
    } else {
      poolEmpty.hidden = true;
      poolList.innerHTML = data.tokens
        .map((token) => {
          const max = token.maxDeployments || 1;
          const used = Math.min(token.current, max);
          const pct = Math.round((used / max) * 100);
          return `
            <div class="pool-item">
              <div class="pool-top">
                <b>${esc(token.label)}</b>
                <span>${used}/${max}${token.status === "error" ? " · error" : token.active === false ? " · off" : ""}</span>
              </div>
              <div class="bar ${used >= max ? "full" : ""}"><i style="width:${Math.max(3, pct)}%"></i></div>
            </div>`;
        })
        .join("");
    }

    const top = $("#ov-top");
    const topEmpty = $("#ov-top-empty");
    if (!data.topUsers.length) {
      top.innerHTML = "";
      topEmpty.hidden = false;
    } else {
      topEmpty.hidden = true;
      top.innerHTML = data.topUsers
        .map(
          (user, index) => `
          <div class="mini-row">
            <span class="rank">${String(index + 1).padStart(2, "0")}</span>
            <span class="avatar">${esc(initials(user.name))}</span>
            <span class="grow">${esc(user.name)}</span>
            <span class="count">${user.deploys}×</span>
          </div>`
        )
        .join("");
    }

    renderJobsTable($("#ov-table"), data.recent || []);
    setPoolUI(data.pool);
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------- owner: tokens ---------------- */

function renderPoolChips(pool) {
  const el = $("#pool-chips");
  if (!pool) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = [
    ["Tokens", pool.tokens],
    ["Healthy", pool.healthy],
    ["Slots used", `${pool.used}/${pool.capacity}`],
    ["Free slots", pool.free],
    ["Deploys run", pool.deploys],
  ]
    .map(([label, value]) => `<div class="pool-chip"><b>${esc(value)}</b><span>${esc(label)}</span></div>`)
    .join("");
}

async function loadTokens() {
  try {
    const data = await api("/api/tokens");
    state.owner.tokens = data.tokens;
    state.owner.pool = data.pool;
    renderPoolChips(data.pool);
    setPoolUI(data.pool);
    renderTokens();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderTokens() {
  const list = $("#token-list");
  const empty = $("#token-empty");
  const tokens = state.owner.tokens;
  if (!tokens.length) {
    list.innerHTML = "";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  list.innerHTML = tokens
    .map((token) => {
      const restricted = token.status === "error";
      const off = token.active === false;
      const stateClass = restricted ? "error" : off ? "off" : "";
      const stateText = restricted ? "Restricted / invalid" : off ? "Disabled" : token.lastCheck ? "Alive · valid" : "Not checked";
      const metaBits = [];
      if (token.lastError) metaBits.push(token.lastError);
      else if (token.note) metaBits.push(token.note);
      if (token.lastCheck) metaBits.push(`last check ${timeAgo(token.lastCheck)}`);
      return `
      <div class="token-row" data-id="${esc(token.id)}">
        <div class="token-name">
          <b>${esc(token.label)}</b>
          <span>${esc(token.masked)}${token.email ? ` · ${esc(token.email)}` : ""} · ${token.total} deploys${metaBits.length ? `<br/><span class="tok-meta">${esc(metaBits.join(" · "))}</span>` : ""}</span>
        </div>
        <div class="token-state ${stateClass}"><i></i>${stateText}</div>
        <div class="token-usage">${token.current}/${token.maxDeployments}</div>
        <div class="token-cfg">
          <label>cap<input class="mini-input" data-field="maxDeployments" type="number" min="1" max="50" value="${token.maxDeployments}" /></label>
          <label>prio<input class="mini-input" data-field="priority" type="number" min="0" max="99" value="${token.priority}" /></label>
        </div>
        <div class="token-actions">
          <button class="btn btn-quiet btn-sm" data-act="check">Check</button>
          <button class="btn btn-quiet btn-sm" data-act="toggle">${token.active === false ? "Enable" : "Disable"}</button>
          <button class="btn btn-danger btn-sm" data-act="remove">Delete</button>
        </div>
      </div>`;
    })
    .join("");

  $$("#token-list .token-row").forEach((row) => {
    const id = row.dataset.id;
    row.querySelectorAll("[data-act]").forEach((btn) =>
      btn.addEventListener("click", () => tokenAction(id, btn.dataset.act))
    );
    row.querySelectorAll(".mini-input").forEach((input) =>
      input.addEventListener("change", () => updateTokenField(id, input.dataset.field, input.value))
    );
  });
}

async function addToken(event) {
  event.preventDefault();
  const error = $("#tok-error");
  error.textContent = "";
  const token = $("#tok-secret").value.trim();
  if (token.length < 20) {
    error.textContent = "Paste a full deploy token.";
    return;
  }
  const button = $("#form-add-token button[type=submit]");
  button.disabled = true;
  button.textContent = "Verifying…";
  try {
    const data = await api("/api/tokens", {
      method: "POST",
      body: {
        token,
        label: $("#tok-label").value.trim(),
        priority: Number($("#tok-prio").value || 0),
        maxDeployments: Number($("#tok-cap").value || 1),
      },
    });
    $("#tok-secret").value = "";
    $("#tok-label").value = "";
    $("#tok-prio").value = "0";
    $("#tok-cap").value = "1";
    toast(data.info?.kind === "workspace" ? "Workspace token added to the pool." : "Account token added to the pool.");
    loadTokens();
  } catch (err) {
    error.textContent = err.message;
  } finally {
    button.disabled = false;
    button.textContent = "Verify & add to pool";
  }
}

async function tokenAction(id, action) {
  try {
    if (action === "check") {
      toast("Checking token…");
      await api(`/api/tokens/${id}/check`, { method: "POST" });
      toast("Token is healthy.");
      loadTokens();
    } else if (action === "toggle") {
      const token = state.owner.tokens.find((t) => t.id === id);
      const data = await api(`/api/tokens/${id}`, { method: "PATCH", body: { active: token.active === false } });
      applyTokenPayload(data);
    } else if (action === "remove") {
      if (!confirm("Remove this token from the pool? Running builds are not affected.")) return;
      await api(`/api/tokens/${id}`, { method: "DELETE" });
      loadTokens();
    }
  } catch (err) {
    toast(err.message, true);
  }
}

async function updateTokenField(id, field, value) {
  try {
    const data = await api(`/api/tokens/${id}`, {
      method: "PATCH",
      body: { [field]: Number(value) },
    });
    applyTokenPayload(data);
  } catch (err) {
    toast(err.message, true);
  }
}

function applyTokenPayload(data) {
  if (data.tokens) state.owner.tokens = data.tokens;
  if (data.pool) {
    state.owner.pool = data.pool;
    renderPoolChips(data.pool);
    setPoolUI(data.pool);
  }
  renderTokens();
}

async function loadDeployTokens() {
  if (!state.owner.tokens.length) await loadTokens();
  const term = $("#c-live-term");
  if (!term.children.length) termNote(term, "Idle. Start a deployment and the build log streams here.");
  if (!state.owner.jobId) $("#c-stop").hidden = true;
}

/* ---------------- owner: users ---------------- */

async function loadUsers() {
  try {
    const data = await api("/api/users");
    state.owner.users = data.users;
    renderUsers();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderUsers() {
  const wrap = $("#user-list");
  const empty = $("#users-empty");
  const query = state.owner.query;
  const users = state.owner.users.filter((user) => {
    if (!query) return true;
    return (
      user.name.toLowerCase().includes(query) ||
      String(user.key).toLowerCase().includes(query) ||
      (user.ip || "").includes(query)
    );
  });
  if (!users.length) {
    wrap.innerHTML = "";
    empty.hidden = false;
    empty.textContent = query ? "No users match that search." : "No visitors have deployed yet.";
    return;
  }
  empty.hidden = true;
  wrap.innerHTML = users
    .map(
      (user) => `
      <div class="user-row ${user.banned ? "banned" : ""}" data-key="${esc(user.key)}">
        <div class="user-main">
          <div class="user-id">
            <span class="avatar">${esc(initials(user.name))}</span>
            <div>
              <b>${esc(user.name)} ${user.banned ? '<span class="badge-you">blocked</span>' : ""}</b>
              <span>${esc(user.key.slice(0, 10))} · ${esc(user.ip || "no ip")}</span>
            </div>
          </div>
          <div class="user-stat">${user.deploys} deploy${user.deploys === 1 ? "" : "s"}</div>
          <div class="user-stat user-seen">${esc(timeAgo(user.lastSeen))}</div>
          <div class="user-stat">${user.deployments.filter((d) => d.status === "success").length} live</div>
          <div class="user-actions">
            <button class="btn btn-quiet btn-sm" data-act="deps">${state.owner.expanded.has(user.key) ? "Hide" : "Builds"}</button>
            <button class="btn btn-quiet btn-sm" data-act="ban">${user.banned ? "Unblock" : "Block"}</button>
            <button class="btn btn-danger btn-sm" data-act="delete">Delete</button>
          </div>
        </div>
        ${
          state.owner.expanded.has(user.key)
            ? `<div class="user-deps">${
                user.deployments.length
                  ? user.deployments
                      .map(
                        (dep) => `
                        <div class="dep-line">
                          <b>${esc(dep.name)}</b>
                          ${statusPill(dep.status)}
                          <span>${esc(dep.type === "github" ? "GitHub" : "ZIP")} · ${esc(dep.tokenLabel || "pool")}</span>
                          <span class="time">${esc(timeAgo(dep.createdAt))}</span>
                        </div>`
                      )
                      .join("")
                  : `<p class="empty">No deployment records.</p>`
              }</div>`
            : ""
        }
      </div>`
    )
    .join("");

  $$("#user-list .user-row").forEach((row) => {
    const key = row.dataset.key;
    row.querySelectorAll("[data-act]").forEach((btn) =>
      btn.addEventListener("click", () => userAction(key, btn.dataset.act))
    );
  });
}

async function userAction(key, action) {
  const user = state.owner.users.find((u) => u.key === key);
  try {
    if (action === "deps") {
      if (state.owner.expanded.has(key)) state.owner.expanded.delete(key);
      else state.owner.expanded.add(key);
      renderUsers();
    } else if (action === "ban") {
      const data = await api(`/api/users/${key}/ban`, { method: "POST", body: { banned: !user.banned } });
      state.owner.users = data.users;
      renderUsers();
      toast(user.banned ? "User unblocked." : "User blocked from deploying.");
    } else if (action === "delete") {
      if (!confirm(`Delete ${user.name} and their user record? Deployment history stays.`)) return;
      const data = await api(`/api/users/${key}`, { method: "DELETE" });
      state.owner.users = data.users;
      state.owner.expanded.delete(key);
      renderUsers();
      toast("User record removed.");
    }
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------- owner: deployments ---------------- */

async function loadJobs() {
  try {
    const data = await api("/api/jobs");
    state.owner.jobs = data.jobs;
    renderJobs();
  } catch (err) {
    toast(err.message, true);
  }
}

function filteredJobs() {
  const filter = state.owner.filter;
  return state.owner.jobs.filter((job) => {
    if (filter === "all") return true;
    if (filter === "public" || filter === "owner") return job.via === filter;
    if (filter === "running") return ["queued", "running"].includes(job.status);
    return job.status === filter;
  });
}

function renderJobs() {
  const table = $("#job-table");
  const jobs = filteredJobs();
  $("#jobs-empty").hidden = jobs.length > 0;
  if (!jobs.length) {
    table.innerHTML = "";
    return;
  }

  const rows = jobs
    .map(
      (job) => `
      <tr>
        <td class="proj">${esc(job.projectName || job.name)}<span class="sub">${esc(job.type === "github" ? "github" : "zip")} · ${esc(job.id)}</span></td>
        <td>${esc(job.userName || "Owner")}<span class="sub">${esc(job.via || "owner")}</span></td>
        <td class="nowrap">${esc(job.tokenLabel || "pool")}</td>
        <td>${statusPill(job.status)}</td>
        <td class="nowrap row-muted">${esc(timeAgo(job.createdAt))}</td>
        <td>
          <div class="actions">
            <button class="btn btn-quiet btn-sm" data-job="${esc(job.id)}" data-act="logs">Logs</button>
            ${job.deploymentUrl ? `<a class="btn btn-quiet btn-sm" href="${appHref(job.id)}" target="_blank" rel="noopener">Open</a>` : ""}
            ${
              ["queued", "running"].includes(job.status)
                ? `<button class="btn btn-danger btn-sm" data-job="${esc(job.id)}" data-act="cancel">Stop</button>`
                : `<button class="btn btn-danger btn-sm" data-job="${esc(job.id)}" data-act="delete">Delete</button>`
            }
          </div>
        </td>
      </tr>`
    )
    .join("");
  table.innerHTML = `<thead><tr><th>Project</th><th>Builder</th><th>Token</th><th>Status</th><th>Started</th><th></th></tr></thead><tbody>${rows}</tbody>`;

  $$("#job-table [data-job]").forEach((btn) =>
    btn.addEventListener("click", () => jobAction(btn.dataset.job, btn.dataset.act))
  );
}

function renderJobsTable(table, jobs) {
  if (!table) return;
  if (!jobs.length) {
    table.innerHTML = `<tbody><tr><td class="row-muted">Nothing here yet.</td></tr></tbody>`;
    return;
  }
  table.innerHTML = `<thead><tr><th>Project</th><th>Builder</th><th>Status</th><th>When</th></tr></thead><tbody>${jobs
    .map(
      (job) => `
      <tr>
        <td class="proj">${esc(job.projectName || job.name)}<span class="sub">${esc(job.type === "github" ? "github" : "zip")}</span></td>
        <td>${esc(job.userName || "Owner")}</td>
        <td>${statusPill(job.status)}</td>
        <td class="nowrap row-muted">${esc(timeAgo(job.createdAt))}</td>
      </tr>`
    )
    .join("")}</tbody>`;
}

async function jobAction(id, action) {
  try {
    if (action === "cancel") {
      await api(`/api/jobs/${id}/cancel`, { method: "POST" });
      toast("Deployment stopped.");
      loadJobs();
      return;
    }
    if (action === "delete") {
      if (!confirm("Delete this app? Its live site and services will be removed permanently.")) return;
      const data = await api(`/api/jobs/${id}`, { method: "DELETE" });
      toast(data.projectDeleted ? "App and its live site deleted." : "Deployment record deleted.");
      loadJobs();
      loadProjects().catch(() => {});
      return;
    }
    if (action === "logs") openLogs(id);
  } catch (err) {
    toast(err.message, true);
  }
}

let logStream = null;
function closeLogStream() {
  if (logStream) {
    logStream.close();
    logStream = null;
  }
}

async function openLogs(id) {
  const modal = $("#log-modal");
  const body = $("#log-body");
  body.innerHTML = "";
  $("#log-title").textContent = "Build logs";
  $("#log-sub").textContent = id;
  modal.showModal();
  try {
    const data = await api(`/api/jobs/${id}`);
    const job = data.job;
    $("#log-title").textContent = job.projectName || job.name;
    $("#log-sub").textContent = `${job.stage || job.status} · ${id}`;
    (job.logs || []).forEach((line) => termLine(body, line));
    if (!job.logs?.length) termNote(body, "No log lines recorded.");
    if (["queued", "running"].includes(job.status)) {
      closeLogStream();
      const es = new EventSource(`/api/jobs/${id}/stream`);
      logStream = es;
      es.addEventListener("log", (event) => termLine(body, JSON.parse(event.data)));
      es.addEventListener("status", (event) => {
        const live = JSON.parse(event.data);
        $("#log-sub").textContent = `${live.stage || live.status} · ${id}`;
        if (["success", "failed", "canceled", "interrupted"].includes(live.status)) {
          es.close();
          if (logStream === es) logStream = null;
        }
      });
    }
  } catch (err) {
    termNote(body, err.message);
  }
}

/* ---------------- owner: projects ---------------- */

async function loadProjects() {
  const list = $("#project-list");
  const empty = $("#projects-empty");
  try {
    const data = await api("/api/host/projects");
    state.owner.projects = data.projects;
    if (!data.projects.length) {
      list.innerHTML = "";
      empty.hidden = false;
      empty.textContent = "This account has no projects yet.";
      return;
    }
    empty.hidden = true;
    list.innerHTML = data.projects
      .map(
        (project) => `
        <article class="project-card" data-pid="${esc(project.id)}">
          <h3>${esc(project.name)}</h3>
          <p class="pmeta">${esc([project.workspace, project.tokenLabel].filter(Boolean).join(" · "))}${project.workspace || project.tokenLabel ? " · " : ""}${esc(project.id)}</p>
          <div class="prow">
            <button class="btn btn-quiet btn-sm" data-manage>Manage</button>
            <button class="btn btn-danger btn-sm" data-del>Delete</button>
          </div>
          <div class="svc-list" hidden></div>
        </article>`
      )
      .join("");
    $$("#project-list .project-card").forEach((card) => {
      const id = card.dataset.pid;
      card.querySelector("[data-manage]").addEventListener("click", () => toggleProjectDetail(card));
      card.querySelector("[data-del]").addEventListener("click", async () => {
        if (!confirm("Delete this project? This removes its services too.")) return;
        try {
          await api(`/api/host/projects/${id}`, { method: "DELETE" });
          toast("Project deleted.");
          loadProjects();
        } catch (err) {
          toast(err.message, true);
        }
      });
    });
  } catch (err) {
    empty.hidden = false;
    empty.textContent = err.message;
  }
}

async function toggleProjectDetail(card) {
  const slot = card.querySelector(".svc-list");
  const id = card.dataset.pid;
  if (!slot.hidden) {
    slot.hidden = true;
    return;
  }
  slot.hidden = false;
  slot.innerHTML = `<p class="empty">Loading services…</p>`;
  try {
    const data = await api(`/api/host/projects/${id}`);
    const project = data.project;
    const env = (project.environments || [])[0] || {};
    const services = project.services || [];
    slot.innerHTML = services.length
      ? services
          .map((svc) => {
            const dep = (svc.deployments || [])[0];
            const url = svc.publicUrl || (dep && (dep.url || dep.staticUrl)) || "";
            return `<div class="svc-row" data-svc="${esc(svc.id)}">
              <div class="svc-info">
                <b>${esc(svc.name)}</b>
                <span>${esc(dep ? friendlyDeployStatus(dep.status) : url ? "live" : "no deployment yet")}${url ? ` · <a href="${appHref(svc.id)}" target="_blank" rel="noopener">Open app</a>` : ""}</span>
              </div>
              <div class="svc-actions">
                <button class="btn btn-quiet btn-sm" data-act="logs" data-dep="${esc(dep?.id || "")}" data-name="${esc(svc.name)}">Logs</button>
                <button class="btn btn-quiet btn-sm" data-act="vars" data-name="${esc(svc.name)}">Variables</button>
              </div>
            </div>`;
          })
          .join("")
      : `<p class="empty">No services in this project.</p>`;
    slot.querySelectorAll("[data-act]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const svcId = btn.closest("[data-svc]").dataset.svc;
        if (btn.dataset.act === "logs") {
          if (!btn.dataset.dep) return toast("This service has no deployment yet.", true);
          openDeploymentLogs(btn.dataset.dep, btn.dataset.name);
        } else {
          openVariables(id, svcId, env.id, project.name, btn.dataset.name);
        }
      })
    );
  } catch (err) {
    slot.innerHTML = `<p class="empty">${esc(err.message)}</p>`;
  }
}

function friendlyDeployStatus(status) {
  const map = {
    SUCCESS: "live",
    BUILDING: "building",
    DEPLOYING: "starting",
    QUEUED: "queued",
    WAITING: "waiting",
    FAILED: "build failed",
    CRASHED: "crashed",
    SLEEPING: "sleeping",
    REMOVED: "removed",
    INITIALIZING: "initializing",
  };
  return map[String(status || "").toUpperCase()] || String(status || "unknown").toLowerCase();
}

async function openDeploymentLogs(deploymentId, serviceName) {
  const modal = $("#log-modal");
  const body = $("#log-body");
  closeLogStream();
  body.innerHTML = "";
  $("#log-title").textContent = `${serviceName} · runtime logs`;
  $("#log-sub").textContent = "loading…";
  modal.showModal();
  try {
    const data = await api(`/api/host/deployments/${deploymentId}/logs`);
    const logs = data.logs || [];
    $("#log-sub").textContent = `${logs.length} lines · ${serviceName}`;
    logs.forEach((line) => termLine(body, line));
    if (!logs.length) termNote(body, "No log lines yet — the app may still be building or haven't printed anything.");
    body.scrollTop = body.scrollHeight;
  } catch (err) {
    termNote(body, err.message);
  }
}

let varsCtx = null;

async function openVariables(projectId, serviceId, environmentId, projectName, serviceName) {
  const modal = $("#vars-modal");
  varsCtx = { projectId, serviceId, environmentId };
  $("#vars-title").textContent = `Variables · ${serviceName || projectName}`;
  $("#vars-sub").textContent = `${projectName} — shared across the service`;
  $("#vars-error").textContent = "";
  $("#vars-text").value = "";
  $("#vars-service").innerHTML = `<option>${esc(serviceName || "service")}</option>`;
  $("#vars-service").disabled = true;
  modal.showModal();
  try {
    const data = await api(`/api/host/projects/${projectId}/variables?serviceId=${encodeURIComponent(serviceId)}`);
    varsCtx.environmentId = data.environmentId || environmentId;
    const entries = Object.entries(data.variables || {});
    $("#vars-sub").textContent = `${projectName} — variables apply to this service`;
    $("#vars-text").value = entries
      .filter(([key]) => !key.startsWith("RAILWAY_"))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
  } catch (err) {
    $("#vars-error").textContent = err.message;
  }
}

async function saveVars() {
  if (!varsCtx) return;
  const error = $("#vars-error");
  error.textContent = "";
  const button = $("#vars-save");
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    const variables = {};
    for (const raw of $("#vars-text").value.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) {
        throw new Error(`Invalid variable name: ${key}`);
      }
      variables[key] = line.slice(eq + 1).trim();
    }
    const data = await api(`/api/host/projects/${varsCtx.projectId}/variables`, {
      method: "POST",
      body: { serviceId: varsCtx.serviceId, environmentId: varsCtx.environmentId, variables },
    });
    toast(`${data.count} variable(s) saved — redeploying service.`);
    $("#vars-modal").close();
  } catch (err) {
    error.textContent = err.message;
  } finally {
    button.disabled = false;
    button.textContent = "Save & redeploy";
  }
}

/* ---------------- owner: database ---------------- */

const DB_URL_KEY = "ghost.dbUrl";

async function healDatabase() {
  try {
    const saved = localStorage.getItem(DB_URL_KEY);
    if (!saved) return false;
    const data = await api("/api/db/status");
    if ((data.urls || []).length) return false;
    await api("/api/db/urls", { method: "POST", body: { label: "Auto-restore", url: saved } });
    toast("Database reconnected automatically.");
    if (state.owner.view === "console" && state.owner.tab === "database") loadDb();
    else loadPublic();
    return true;
  } catch {
    return false;
  }
}

async function loadDb() {
  try {
    const data = await api("/api/db/status");
    state.owner.db = data;
    const banner = $("#db-mode");
    if (data.mode === "mongo") {
      banner.className = "banner";
      banner.textContent = "Connected to MongoDB. Deployments, tokens and users are stored in the database.";
    } else {
      banner.className = "banner error";
      banner.textContent = data.lastError
        ? `MongoDB unavailable — using the local JSON snapshot. (${data.lastError})`
        : "No MongoDB configured — using the local JSON snapshot.";
    }
    renderDbUrls(data.urls);
    if ((data.urls || []).length && !localStorage.getItem(DB_URL_KEY)) {
      api("/api/db/active-url")
        .then((row) => row?.url && localStorage.setItem(DB_URL_KEY, row.url))
        .catch(() => {});
    }
  } catch (err) {
    toast(err.message, true);
  }
}

function renderDbUrls(urls) {
  const list = $("#db-list");
  const empty = $("#db-empty");
  if (!urls.length) {
    list.innerHTML = "";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  list.innerHTML = urls
    .map(
      (row) => `
      <div class="db-row">
        <div>
          <b>${row.active ? '<span class="dot-live"></span>' : ""}${esc(row.label)}</b>
          <span>${esc(row.host)}</span>
        </div>
        <div class="db-actions">
          <button class="btn btn-quiet btn-sm" data-id="${esc(row.id)}" data-act="test">Test</button>
          <button class="btn btn-quiet btn-sm" data-id="${esc(row.id)}" data-act="activate" ${row.active ? "disabled" : ""}>Use</button>
          ${
            row.fromEnv
              ? `<span class="badge-you">env</span>`
              : `<button class="btn btn-danger btn-sm" data-id="${esc(row.id)}" data-act="remove">Remove</button>`
          }
        </div>
      </div>`
    )
    .join("");

  $$("#db-list [data-id]").forEach((btn) =>
    btn.addEventListener("click", () => dbAction(btn.dataset.id, btn.dataset.act))
  );
}

async function addDbUrl(event) {
  event.preventDefault();
  const error = $("#db-error");
  error.textContent = "";
  const url = $("#db-url").value.trim();
  if (!url) {
    error.textContent = "Paste a MongoDB connection string.";
    return;
  }
  try {
    await api("/api/db/urls", { method: "POST", body: { label: $("#db-label").value.trim(), url } });
    localStorage.setItem(DB_URL_KEY, url);
    $("#db-url").value = "";
    $("#db-label").value = "";
    toast("MongoDB saved.");
    loadDb();
  } catch (err) {
    error.textContent = err.message;
  }
}

async function dbAction(id, action) {
  try {
    if (action === "test") {
      const data = await api(`/api/db/urls/${id}/test`, { method: "POST" });
      toast(data.ok ? "Connection successful." : data.message, !data.ok);
    } else if (action === "activate") {
      await api(`/api/db/urls/${id}/activate`, { method: "POST" });
      toast("Switched database.");
      loadDb();
    } else if (action === "remove") {
      if (!confirm("Remove this MongoDB URL?")) return;
      await api(`/api/db/urls/${id}`, { method: "DELETE" });
      try {
        const st = await api("/api/db/status");
        if (!(st.urls || []).length) localStorage.removeItem(DB_URL_KEY);
      } catch {
        /* ignore */
      }
      loadDb();
    }
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------- login ---------------- */

function showLogin(message = "") {
  const modal = $("#login-modal");
  $("#login-error").textContent = message;
  $("#login-password").value = "";
  if (!modal.open) modal.showModal();
  setTimeout(() => $("#login-password").focus(), 60);
}

function wireLogin() {
  $("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const error = $("#login-error");
    error.textContent = "";
    const button = $("#btn-login-submit");
    button.disabled = true;
    try {
      await api("/api/login", { method: "POST", body: { password: $("#login-password").value } });
      state.session = { authed: true };
      $("#login-modal").close();
      openConsole();
      toast("Console unlocked.");
      healDatabase();
    } catch (err) {
      error.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });
  $("#btn-login-cancel").addEventListener("click", () => $("#login-modal").close());
}

/* ---------------- boot ---------------- */

async function boot() {
  wirePublic();
  wireConsole();
  wireLogin();

  $("#footer-ver").textContent = "";
  try {
    const [session, meta] = await Promise.all([api("/api/session"), api("/api/meta")]);
    state.session = session;
    state.meta = meta;
    $("#footer-ver").textContent = `v${meta.version}`;
    $("#c-version").textContent = `v${meta.version}`;
    $("#zip-limit").textContent = meta.maxZipMB;
  } catch {
    /* offline */
  }

  await loadPublic();
  await refreshMyJobs();
  if (state.session?.authed) healDatabase();

  const uptimeTick = () => {
    if (!state.meta || !state.session) return;
    const started = Date.now() - (state.session.uptimeSec || 0) * 1000;
    const mins = Math.max(0, Math.floor((Date.now() - started) / 60000));
    $("#c-uptime").textContent = mins >= 60 ? `up ${Math.floor(mins / 60)}h ${mins % 60}m` : `up ${mins}m`;
  };
  uptimeTick();
  setInterval(uptimeTick, 60000);
  setInterval(loadPublic, 60000);

  window.addEventListener("hashchange", () => {
    if (location.hash === "#/console") {
      if (state.session?.authed) openConsole();
      else showLogin();
    } else if (state.owner.view === "console") {
      setView("site");
    }
  });

  if (location.hash === "#/console") {
    if (state.session?.authed) openConsole();
    else showLogin();
  }
}

boot();
