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
    depltoken: { actor: 'deployer@contoso.com', roles: ['deployer'] },
    pltoken: { actor: 'platform@contoso.com', roles: ['platform'] },
  });
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
    justification: 'phase 3 test',
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
