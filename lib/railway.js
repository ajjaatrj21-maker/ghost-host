const API = "https://backboard.railway.com/graphql/v2";

class RailwayError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "RailwayError";
    this.details = details;
  }
}

async function request(query, variables, headers) {
  let res;
  try {
    res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(25000),
    });
  } catch (err) {
    throw new RailwayError(`Could not reach Railway API: ${err.message}`);
  }

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw new RailwayError(`Railway API returned HTTP ${res.status} (non JSON response)`);
  }

  if (json.errors && json.errors.length) {
    const first = json.errors[0];
    const message = String(first.message || "Unknown GraphQL error");
    const code = first.extensions?.code || "";
    const traceId = first.extensions?.traceId || "";
    if (res.status === 429 || /rate limit/i.test(message)) {
      const retry = res.headers.get("retry-after");
      throw new RailwayError(
        `Railway rate limit reached${retry ? ` — retry after ${retry}s` : ""}. Free accounts allow 100 requests/hour.`
      );
    }
    if (/not authorized/i.test(message)) {
      throw new RailwayError("Railway rejected this token (Not Authorized).", { code, traceId });
    }
    const suffix = code || traceId ? ` (${[code, traceId && `trace ${traceId}`].filter(Boolean).join(" · ")})` : "";
    throw new RailwayError(message + suffix, { code, traceId });
  }

  if (!res.ok) {
    throw new RailwayError(`Railway API error (HTTP ${res.status})`);
  }

  return json.data;
}

function gql(token, query, variables = {}) {
  return request(query, variables, { Authorization: `Bearer ${token}` });
}

const Q_ME = `query { me { id name email workspaces { id name } } }`;
const Q_PROJECTS = `query { projects { edges { node { id name description createdAt } } } }`;
const Q_PROJECT_TOKEN = `query { projectToken { projectId environmentId } }`;

async function checkToken(token) {
  let firstError = null;
  try {
    const data = await gql(token, Q_ME);
    if (data.me?.id) {
      const workspace = (data.me.workspaces || [])[0] || null;
      return {
        ok: true,
        kind: "account",
        name: data.me.name || "",
        email: data.me.email || "",
        workspaceId: workspace?.id || "",
        workspaceName: workspace?.name || "",
        note: "",
      };
    }
    firstError = new RailwayError("Railway did not return an account for this token.");
  } catch (err) {
    firstError = err;
  }

  try {
    await request(Q_PROJECT_TOKEN, {}, { "Project-Access-Token": token });
    throw new RailwayError(
      "This is a Project token. The pool needs an Account or Workspace token (railway.com/account/tokens) — each deploy here creates a new Railway project, and a Project token is locked to one existing project."
    );
  } catch (err) {
    if (err instanceof RailwayError && /^This is a Project token/.test(err.message)) throw err;
  }

  for (const query of [Q_PROJECTS, `query { regions { name } }`]) {
    try {
      await gql(token, query);
      return {
        ok: true,
        kind: "workspace",
        name: "",
        email: "",
        workspaceId: "",
        workspaceName: "",
        note: "Workspace token — scoped to its workspace, no personal account data.",
      };
    } catch {
      /* try the next probe */
    }
  }

  if (firstError && /not authorized/i.test(firstError.message)) {
    throw new RailwayError(
      "Railway rejected this token (Not Authorized). Use an Account token (No workspace selected) or a Workspace token from railway.com/account/tokens — Project tokens cannot create projects.",
      firstError.details
    );
  }
  throw firstError;
}

const Q_MY_PROJECTS = `query {
  me {
    workspaces {
      id
      name
      projects {
        edges { node { id name createdAt } }
      }
    }
  }
}`;

async function listProjects(token) {
  try {
    const data = await gql(token, Q_MY_PROJECTS);
    const workspaces = data.me?.workspaces || [];
    const projects = [];
    for (const ws of workspaces) {
      for (const edge of ws.projects?.edges || []) {
        if (edge.node?.id) projects.push({ ...edge.node, workspace: ws.name });
      }
    }
    return projects;
  } catch {
    const data = await gql(token, Q_PROJECTS);
    return (data.projects?.edges || []).map((e) => e.node);
  }
}

async function projectInfo(token, projectId) {
  const data = await gql(
    token,
    `query project($id: String!) {
      project(id: $id) {
        id name description createdAt
        services { edges { node { id name icon } } }
        environments { edges { node { id name } } }
      }
    }`,
    { id: projectId }
  );
  const p = data.project;
  return {
    ...p,
    services: (p.services?.edges || []).map((e) => e.node),
    environments: (p.environments?.edges || []).map((e) => e.node),
  };
}

async function getEnvironments(token, projectId) {
  const data = await gql(
    token,
    `query environments($projectId: String!) {
      environments(projectId: $projectId) {
        edges { node { id name createdAt } }
      }
    }`,
    { projectId }
  );
  return (data.environments?.edges || []).map((e) => e.node);
}

async function defaultWorkspaceId(token) {
  try {
    const data = await gql(token, `query { me { workspaces { id } } }`);
    return (data.me?.workspaces || [])[0]?.id || "";
  } catch {
    return "";
  }
}

async function createProject(token, name) {
  const workspaceId = await defaultWorkspaceId(token);
  const input = { name };
  if (workspaceId) input.workspaceId = workspaceId;
  const data = await gql(
    token,
    `mutation projectCreate($input: ProjectCreateInput!) {
      projectCreate(input: $input) { id name }
    }`,
    { input }
  );
  return data.projectCreate;
}

async function createService(token, { projectId, name, repo, branch }) {
  const input = { projectId, name };
  if (repo) {
    input.source = { repo };
    if (branch) input.branch = branch;
  }
  const data = await gql(
    token,
    `mutation serviceCreate($input: ServiceCreateInput!) {
      serviceCreate(input: $input) { id name }
    }`,
    { input }
  );
  return data.serviceCreate;
}

async function deployService(token, serviceId, environmentId) {
  const data = await gql(
    token,
    `mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) {
      serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
    }`,
    { serviceId, environmentId }
  );
  return data.serviceInstanceDeployV2;
}

async function updateServiceInstance(token, serviceId, environmentId, input) {
  await gql(
    token,
    `mutation serviceInstanceUpdate($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
      serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
    }`,
    { serviceId, environmentId, input }
  );
}

async function listDeployments(token, { projectId, serviceId, environmentId, first = 10 }) {
  const data = await gql(
    token,
    `query deployments($input: DeploymentListInput!, $first: Int) {
      deployments(input: $input, first: $first) {
        edges {
          node { id status createdAt url staticUrl canRedeploy canRollback }
        }
      }
    }`,
    { input: { projectId, serviceId, environmentId }, first }
  );
  return (data.deployments?.edges || []).map((e) => e.node);
}

async function stopDeployment(token, id) {
  await gql(token, `mutation deploymentStop($id: String!) { deploymentStop(id: $id) }`, { id });
}

async function deleteProject(token, id) {
  await gql(token, `mutation projectDelete($id: String!) { projectDelete(id: $id) }`, { id });
}

module.exports = {
  gql,
  checkToken,
  listProjects,
  projectInfo,
  getEnvironments,
  createProject,
  createService,
  deployService,
  updateServiceInstance,
  listDeployments,
  stopDeployment,
  deleteProject,
  RailwayError,
};
