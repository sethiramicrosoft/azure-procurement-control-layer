const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const REPO_ROOT = path.resolve(__dirname, '..');

function randomPort() {
  return 35000 + Math.floor(Math.random() * 9000);
}

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apcl-test-'));
}

function createStaticTokens() {
  return JSON.stringify({
    reqtoken: { actor: 'requester@contoso.com', roles: ['requester'] },
    proctoken: { actor: 'procurement@contoso.com', roles: ['procurement'] },
    rogueproctoken: { actor: 'rogue-procurement@contoso.com', roles: ['procurement'] },
    depltoken: { actor: 'deployer@contoso.com', roles: ['deployer'] },
    pipelinetoken: { actor: 'pipeline@contoso.com', roles: ['deployer'] },
    pltoken: { actor: 'platform@contoso.com', roles: ['platform'] },
  });
}

function easyAuthPrincipal({ actor, roles = [], groups = [], appId = 'apcl-client-id' }) {
  const claims = [
    { typ: 'preferred_username', val: actor },
    { typ: 'appid', val: appId },
  ];
  for (const role of roles) {
    claims.push({ typ: 'roles', val: role });
  }
  for (const group of groups) {
    claims.push({ typ: 'groups', val: group });
  }
  const principal = { claims };
  return Buffer.from(JSON.stringify(principal), 'utf8').toString('base64');
}

async function waitForServer(proc, timeoutMs = 15000) {
  const start = Date.now();
  let stdout = '';
  let stderr = '';
  return await new Promise((resolve, reject) => {
    const onData = chunk => {
      const text = chunk.toString();
      stdout += text;
      if (stdout.includes('APCL running at http://localhost:')) {
        cleanup();
        resolve({ stdout, stderr });
      } else if (Date.now() - start > timeoutMs) {
        cleanup();
        reject(new Error(`timeout waiting for server start\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }
    };
    const onErr = chunk => {
      stderr += chunk.toString();
    };
    const onExit = code => {
      cleanup();
      reject(new Error(`server exited early with code ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    };
    const cleanup = () => {
      proc.stdout.off('data', onData);
      proc.stderr.off('data', onErr);
      proc.off('exit', onExit);
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onErr);
    proc.on('exit', onExit);
  });
}

function startApcl(overrides = {}) {
  const port = randomPort();
  const tempDir = createTempDir();
  const env = {
    ...process.env,
    PORT: String(port),
    APCL_AUTH_MODE: 'static',
    APCL_STATIC_TOKENS_JSON: createStaticTokens(),
    APCL_STATE_BACKEND: 'sqlite',
    APCL_SQLITE_DB_PATH: path.join(tempDir, 'apcl.db'),
    APCL_AUDIT_EXPORT_PATH: path.join(tempDir, 'audit-export.jsonl'),
    ...overrides,
  };

  const proc = spawn('node', ['server.js'], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return {
    proc,
    tempDir,
    baseUrl: `http://localhost:${port}`,
    async ready() {
      await waitForServer(proc);
    },
    async stop() {
      if (!proc.killed) proc.kill();
      await new Promise(resolve => proc.once('exit', () => resolve()));
    },
  };
}

async function api(baseUrl, pathName, { method = 'GET', token, body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

function requestPayload() {
  return {
    title: 'Test request',
    tenant: 'tenant-a',
    subscription: 'sub-a',
    resourceType: 'Microsoft.Compute/virtualMachines',
    region: 'australiaeast',
    sku: 'Standard_D2s_v5',
    costCenter: 'FIN001',
    poId: 'PO-1',
    owner: 'owner@contoso.com',
    managerApproverEmail: 'manager@contoso.com',
    procurementApproverEmail: 'procurement@contoso.com',
    desiredBudgetCap: 5000,
    estimatedMonthlyCost: 200,
    justification: 'phase test',
  };
}

test('auth + entitlement single-use enforcement', async () => {
  const app = startApcl({ APCL_DEPLOYMENT_MODE: 'local' });
  await app.ready();
  try {
    const unauthorized = await api(app.baseUrl, '/api/summary');
    assert.equal(unauthorized.response.status, 401);

    const created = await api(app.baseUrl, '/api/requests', {
      method: 'POST',
      token: 'reqtoken',
      body: requestPayload(),
    });
    assert.equal(created.response.status, 201);
    const reqId = created.payload.request.id;

    const decision = await api(app.baseUrl, `/api/requests/${reqId}/decision`, {
      method: 'POST',
      token: 'proctoken',
      body: { decision: 'approved', comment: 'ok' },
    });
    assert.equal(decision.response.status, 200);

    const ent = await api(app.baseUrl, `/api/requests/${reqId}/entitlement`, {
      method: 'POST',
      token: 'proctoken',
      body: {},
    });
    assert.equal(ent.response.status, 200);
    const entitlementToken = ent.payload.entitlementToken;
    assert.ok(entitlementToken);

    const deploy = await api(app.baseUrl, `/api/requests/${reqId}/deploy`, {
      method: 'POST',
      token: 'depltoken',
      body: { entitlementToken },
    });
    assert.equal(deploy.response.status, 200);

    const deployAgain = await api(app.baseUrl, `/api/requests/${reqId}/deploy`, {
      method: 'POST',
      token: 'depltoken',
      body: { entitlementToken },
    });
    assert.equal(deployAgain.response.status, 409);
    assert.match(
      String(deployAgain.payload.error || ''),
      /already consumed|already used|request must be approved/i
    );
  } finally {
    await app.stop();
  }
});

test('webhook signing + callback status token flow', async () => {
  const webhookPort = randomPort();
  let webhookRequest = null;
  const webhookServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => {
      webhookRequest = {
        headers: req.headers,
        body: body ? JSON.parse(body) : {},
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ runId: 'external-123' }));
    });
  });
  await new Promise(resolve => webhookServer.listen(webhookPort, resolve));

  const app = startApcl({
    APCL_DEPLOYMENT_MODE: 'webhook',
    APCL_DEPLOYMENT_WEBHOOK_URL: `http://localhost:${webhookPort}/hook`,
    APCL_DEPLOYMENT_WEBHOOK_HMAC_SECRET: 'hmac-secret',
    APCL_DEPLOYMENT_STATUS_TOKEN: 'status-secret',
  });
  await app.ready();

  try {
    const created = await api(app.baseUrl, '/api/requests', {
      method: 'POST',
      token: 'reqtoken',
      body: requestPayload(),
    });
    const reqId = created.payload.request.id;

    await api(app.baseUrl, `/api/requests/${reqId}/decision`, {
      method: 'POST',
      token: 'proctoken',
      body: { decision: 'approved', comment: 'ok' },
    });

    const ent = await api(app.baseUrl, `/api/requests/${reqId}/entitlement`, {
      method: 'POST',
      token: 'proctoken',
      body: {},
    });
    const entitlementToken = ent.payload.entitlementToken;

    const deploy = await api(app.baseUrl, `/api/requests/${reqId}/deploy`, {
      method: 'POST',
      token: 'depltoken',
      body: { entitlementToken },
    });
    assert.equal(deploy.response.status, 202);
    const executionId = deploy.payload.execution.id;
    assert.ok(executionId);

    assert.ok(webhookRequest);
    assert.ok(webhookRequest.headers['x-apcl-signature']);
    assert.ok(webhookRequest.headers['x-apcl-timestamp']);
    assert.ok(webhookRequest.headers['idempotency-key']);

    const statusUpdate = await api(app.baseUrl, `/api/deployments/${executionId}/status`, {
      method: 'POST',
      headers: { 'x-apcl-status-token': 'status-secret' },
      body: { status: 'succeeded', externalRunId: 'external-123', resultMessage: 'done' },
    });
    assert.equal(statusUpdate.response.status, 200);

    const requests = await api(app.baseUrl, '/api/requests', { token: 'reqtoken' });
    const updated = requests.payload.requests.find(r => r.id === reqId);
    assert.equal(updated.state, 'deployed');
  } finally {
    await app.stop();
    await new Promise(resolve => webhookServer.close(resolve));
  }
});

test('approval authority is enforced for procurement actions', async () => {
  const app = startApcl({ APCL_DEPLOYMENT_MODE: 'local' });
  await app.ready();
  try {
    const created = await api(app.baseUrl, '/api/requests', {
      method: 'POST',
      token: 'reqtoken',
      body: {
        ...requestPayload(),
        procurementApproverEmail: 'procurement@contoso.com',
      },
    });
    assert.equal(created.response.status, 201);
    const reqId = created.payload.request.id;

    const unauthorizedDecision = await api(app.baseUrl, `/api/requests/${reqId}/decision`, {
      method: 'POST',
      token: 'rogueproctoken',
      body: { decision: 'approved', comment: 'try approve' },
    });
    assert.equal(unauthorizedDecision.response.status, 403);
    assert.match(String(unauthorizedDecision.payload.error || ''), /not authorized/i);

    const authorizedDecision = await api(app.baseUrl, `/api/requests/${reqId}/decision`, {
      method: 'POST',
      token: 'proctoken',
      body: { decision: 'approved', comment: 'approved' },
    });
    assert.equal(authorizedDecision.response.status, 200);
  } finally {
    await app.stop();
  }
});

test('callback token errors and status transition guard are enforced', async () => {
  const webhookPort = randomPort();
  const webhookServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ runId: 'external-guard' }));
    });
  });
  await new Promise(resolve => webhookServer.listen(webhookPort, resolve));

  const app = startApcl({
    APCL_DEPLOYMENT_MODE: 'webhook',
    APCL_DEPLOYMENT_WEBHOOK_URL: `http://localhost:${webhookPort}/hook`,
    APCL_DEPLOYMENT_WEBHOOK_HMAC_SECRET: 'hmac-secret',
    APCL_DEPLOYMENT_STATUS_TOKEN: 'status-secret',
  });
  await app.ready();

  try {
    const created = await api(app.baseUrl, '/api/requests', {
      method: 'POST',
      token: 'reqtoken',
      body: requestPayload(),
    });
    const reqId = created.payload.request.id;

    await api(app.baseUrl, `/api/requests/${reqId}/decision`, {
      method: 'POST',
      token: 'proctoken',
      body: { decision: 'approved', comment: 'ok' },
    });

    const ent = await api(app.baseUrl, `/api/requests/${reqId}/entitlement`, {
      method: 'POST',
      token: 'proctoken',
      body: {},
    });
    const entitlementToken = ent.payload.entitlementToken;

    const deploy = await api(app.baseUrl, `/api/requests/${reqId}/deploy`, {
      method: 'POST',
      token: 'depltoken',
      body: { entitlementToken },
    });
    assert.equal(deploy.response.status, 202);
    const executionId = deploy.payload.execution.id;

    const missingToken = await api(app.baseUrl, `/api/deployments/${executionId}/status`, {
      method: 'POST',
      body: { status: 'running', externalRunId: 'external-guard' },
    });
    assert.equal(missingToken.response.status, 401);

    const invalidToken = await api(app.baseUrl, `/api/deployments/${executionId}/status`, {
      method: 'POST',
      headers: { 'x-apcl-status-token': 'wrong-token' },
      body: { status: 'running', externalRunId: 'external-guard' },
    });
    assert.equal(invalidToken.response.status, 401);
    assert.match(String(invalidToken.payload.error || ''), /invalid deployment status token/i);

    const markSucceeded = await api(app.baseUrl, `/api/deployments/${executionId}/status`, {
      method: 'POST',
      headers: { 'x-apcl-status-token': 'status-secret' },
      body: { status: 'succeeded', externalRunId: 'external-guard', resultMessage: 'done' },
    });
    assert.equal(markSucceeded.response.status, 200);

    const regressToRunning = await api(app.baseUrl, `/api/deployments/${executionId}/status`, {
      method: 'POST',
      headers: { 'x-apcl-status-token': 'status-secret' },
      body: { status: 'running', externalRunId: 'external-guard' },
    });
    assert.equal(regressToRunning.response.status, 409);
    assert.match(String(regressToRunning.payload.error || ''), /invalid status transition/i);
  } finally {
    await app.stop();
    await new Promise(resolve => webhookServer.close(resolve));
  }
});

test('deploy governance allowlist and idempotency replay are enforced', async () => {
  const app = startApcl({
    APCL_DEPLOYMENT_MODE: 'local',
    APCL_ENFORCE_DEPLOYER_ALLOWLIST: 'true',
    APCL_ALLOWED_DEPLOYER_IDENTITIES: 'pipeline@contoso.com',
  });
  await app.ready();
  try {
    const created = await api(app.baseUrl, '/api/requests', {
      method: 'POST',
      token: 'reqtoken',
      body: requestPayload(),
    });
    const reqId = created.payload.request.id;

    await api(app.baseUrl, `/api/requests/${reqId}/decision`, {
      method: 'POST',
      token: 'proctoken',
      body: { decision: 'approved', comment: 'ok' },
    });

    const ent = await api(app.baseUrl, `/api/requests/${reqId}/entitlement`, {
      method: 'POST',
      token: 'proctoken',
      body: {},
    });
    const entitlementToken = ent.payload.entitlementToken;

    const blockedDeploy = await api(app.baseUrl, `/api/requests/${reqId}/deploy`, {
      method: 'POST',
      token: 'depltoken',
      body: { entitlementToken },
      headers: { 'idempotency-key': 'deploy-key-1' },
    });
    assert.equal(blockedDeploy.response.status, 403);

    const deployed = await api(app.baseUrl, `/api/requests/${reqId}/deploy`, {
      method: 'POST',
      token: 'pipelinetoken',
      body: { entitlementToken },
      headers: { 'idempotency-key': 'deploy-key-2' },
    });
    assert.equal(deployed.response.status, 200);
    assert.equal(deployed.payload.idempotencyKey, 'deploy-key-2');
    const executionId = deployed.payload.execution.id;

    const replayed = await api(app.baseUrl, `/api/requests/${reqId}/deploy`, {
      method: 'POST',
      token: 'pipelinetoken',
      body: { entitlementToken: 'intentionally-invalid-on-replay' },
      headers: { 'idempotency-key': 'deploy-key-2' },
    });
    assert.equal(replayed.response.status, 200);
    assert.equal(replayed.payload.idempotentReplay, true);
    assert.equal(replayed.payload.execution.id, executionId);
  } finally {
    await app.stop();
  }
});

test('easyauth role/group mapping and app allowlist enforcement', async () => {
  const groupRoleMap = {
    'group-requester': ['requester'],
    'group-procurement': ['procurement'],
  };
  const app = startApcl({
    APCL_AUTH_MODE: 'easyauth',
    APCL_EASYAUTH_GROUP_ROLE_MAP_JSON: JSON.stringify(groupRoleMap),
    APCL_EASYAUTH_ALLOWED_APP_IDS: 'apcl-client-id',
  });
  await app.ready();
  try {
    const deniedSummary = await api(app.baseUrl, '/api/summary', {
      headers: {
        'x-ms-client-principal': easyAuthPrincipal({
          actor: 'user@contoso.com',
          groups: ['group-requester'],
          appId: 'wrong-client-id',
        }),
      },
    });
    assert.equal(deniedSummary.response.status, 401);

    const created = await api(app.baseUrl, '/api/requests', {
      method: 'POST',
      headers: {
        'x-ms-client-principal': easyAuthPrincipal({
          actor: 'requester@contoso.com',
          groups: ['group-requester'],
          appId: 'apcl-client-id',
        }),
      },
      body: requestPayload(),
    });
    assert.equal(created.response.status, 201);
    const reqId = created.payload.request.id;

    const approved = await api(app.baseUrl, `/api/requests/${reqId}/decision`, {
      method: 'POST',
      headers: {
        'x-ms-client-principal': easyAuthPrincipal({
          actor: 'procurement@contoso.com',
          groups: ['group-procurement'],
          appId: 'apcl-client-id',
        }),
      },
      body: { decision: 'approved', comment: 'approved via group mapping' },
    });
    assert.equal(approved.response.status, 200);
  } finally {
    await app.stop();
  }
});

test('webhook polling can finalize deployment to succeeded', async () => {
  const webhookPort = randomPort();
  const pollPort = randomPort();
  let pollCount = 0;

  const webhookServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ runId: 'poll-run-1' }));
  });
  const pollServer = http.createServer((req, res) => {
    pollCount += 1;
    const status = pollCount >= 2 ? 'succeeded' : 'running';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status, resultMessage: 'polled' }));
  });
  await new Promise(resolve => webhookServer.listen(webhookPort, resolve));
  await new Promise(resolve => pollServer.listen(pollPort, resolve));

  const app = startApcl({
    APCL_DEPLOYMENT_MODE: 'webhook',
    APCL_DEPLOYMENT_WEBHOOK_URL: `http://localhost:${webhookPort}/hook`,
    APCL_DEPLOYMENT_WEBHOOK_HMAC_SECRET: 'hmac-secret',
    APCL_DEPLOYMENT_STATUS_TOKEN: 'status-secret',
    APCL_DEPLOYMENT_POLL_ENABLED: 'true',
    APCL_DEPLOYMENT_POLL_URL_TEMPLATE: `http://localhost:${pollPort}/runs/{runId}`,
    APCL_DEPLOYMENT_POLL_INTERVAL_MS: '200',
    APCL_DEPLOYMENT_POLL_MAX_ATTEMPTS: '5',
  });
  await app.ready();

  try {
    const created = await api(app.baseUrl, '/api/requests', {
      method: 'POST',
      token: 'reqtoken',
      body: requestPayload(),
    });
    const reqId = created.payload.request.id;

    await api(app.baseUrl, `/api/requests/${reqId}/decision`, {
      method: 'POST',
      token: 'proctoken',
      body: { decision: 'approved', comment: 'ok' },
    });

    const ent = await api(app.baseUrl, `/api/requests/${reqId}/entitlement`, {
      method: 'POST',
      token: 'proctoken',
      body: {},
    });

    const deploy = await api(app.baseUrl, `/api/requests/${reqId}/deploy`, {
      method: 'POST',
      token: 'depltoken',
      body: { entitlementToken: ent.payload.entitlementToken },
    });
    assert.equal(deploy.response.status, 200);
    assert.equal(deploy.payload.execution.status, 'succeeded');
    assert.ok(pollCount >= 2);
  } finally {
    await app.stop();
    await new Promise(resolve => webhookServer.close(resolve));
    await new Promise(resolve => pollServer.close(resolve));
  }
});

test('governance posture endpoint is available for security/platform roles', async () => {
  const app = startApcl({ APCL_DEPLOYMENT_MODE: 'local' });
  await app.ready();
  try {
    const unauthorized = await api(app.baseUrl, '/api/governance/posture', { token: 'reqtoken' });
    assert.equal(unauthorized.response.status, 403);

    const posture = await api(app.baseUrl, '/api/governance/posture', { token: 'pltoken' });
    assert.equal(posture.response.status, 200);
    assert.ok(posture.payload.posture);
    assert.ok(Array.isArray(posture.payload.posture.checks));
  } finally {
    await app.stop();
  }
});

test('readiness endpoint reports ready in non-production mode', async () => {
  const app = startApcl({ APCL_DEPLOYMENT_MODE: 'local' });
  await app.ready();
  try {
    const readiness = await api(app.baseUrl, '/api/readiness');
    assert.equal(readiness.response.status, 200);
    assert.equal(readiness.payload.ready, true);
    assert.ok(Array.isArray(readiness.payload.issues));
  } finally {
    await app.stop();
  }
});

test('production startup fails when persistent state and audit paths are unsafe', async () => {
  const port = randomPort();
  const tempDir = createTempDir();
  const env = {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'production',
    APCL_ENTITLEMENT_SECRET: 'prod-secret',
    APCL_AUTH_MODE: 'easyauth',
    APCL_EASYAUTH_ALLOWED_APP_IDS: 'apcl-client-id',
    APCL_EASYAUTH_ALLOWED_TENANT_IDS: 'tenant-a',
    APCL_DEPLOYMENT_MODE: 'webhook',
    APCL_DEPLOYMENT_WEBHOOK_URL: 'https://example.invalid/hook',
    APCL_DEPLOYMENT_WEBHOOK_HMAC_SECRET: 'hmac-secret',
    APCL_DEPLOYMENT_STATUS_TOKEN: 'status-secret',
    APCL_ENFORCE_DEPLOYER_ALLOWLIST: 'true',
    APCL_ALLOWED_DEPLOYER_IDENTITIES: 'pipeline@contoso.com',
    APCL_STATE_BACKEND: 'sqlite',
    APCL_SQLITE_DB_PATH: '/tmp/apcl.db',
    APCL_AUDIT_EXPORT_PATH: '/tmp/audit-export.jsonl',
    APCL_AUDIT_EXPORT_SECRET: 'audit-secret',
    APCL_STATIC_TOKENS_JSON: createStaticTokens(),
  };

  const proc = spawn('node', ['server.js'], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  proc.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });

  const exitCode = await new Promise(resolve => proc.once('exit', resolve));
  assert.notEqual(exitCode, 0);
  assert.match(stderr, /production readiness checks failed/i);
});
