const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

const policyPack = {
  allowedLocations: ['australiaeast', 'australiasoutheast'],
  allowedVmSkus: ['Standard_D2s_v5', 'Standard_D4s_v5'],
  requiredTags: ['CostCenter', 'PO_ID', 'Owner', 'RequestId'],
};

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function seedState() {
  const baseBudget = 25000;
  return {
    metadata: {
      version: '1.0.0',
      createdAt: nowIso(),
      policyPackVersion: 'apcl-baseline-initiative@1.0.0',
    },
    requests: [
      {
        id: makeId('req'),
        number: 'APCL-2026-0001',
        title: 'Approved VM for finance analytics sandbox',
        requester: 'alex.engineer@contoso.com',
        tenant: 'contoso-prod',
        subscription: 'sub-prod-finance',
        resourceType: 'Microsoft.Compute/virtualMachines',
        region: 'australiaeast',
        sku: 'Standard_D2s_v5',
        costCenter: 'FIN001',
        poId: 'PO-2026-1001',
        owner: 'finance-platform@contoso.com',
        estimatedMonthlyCost: 480,
        justification: 'Analytics sandbox for finance reporting.',
        state: 'deployed',
        policyResult: 'pass',
        approvals: [
          { step: 1, approver: 'manager@contoso.com', decision: 'approved', comment: 'OK for sandbox', at: nowIso() },
          { step: 2, approver: 'procurement@contoso.com', decision: 'approved', comment: 'PO aligned', at: nowIso() },
        ],
        deployments: [
          { id: makeId('dep'), name: 'approved-vm-2026-0001', deployedBy: 'pipeline@contoso.com', status: 'succeeded', at: nowIso() },
        ],
        createdAt: nowIso(),
        updatedAt: nowIso(),
      },
      {
        id: makeId('req'),
        number: 'APCL-2026-0002',
        title: 'Blocked AKS request without PO',
        requester: 'sam.engineer@contoso.com',
        tenant: 'contoso-prod',
        subscription: 'sub-prod-platform',
        resourceType: 'Microsoft.ContainerService/managedClusters',
        region: 'eastus',
        sku: 'Standard_D4s_v5',
        costCenter: '',
        poId: '',
        owner: 'platform@contoso.com',
        estimatedMonthlyCost: 3400,
        justification: 'New platform cluster for internal tooling.',
        state: 'blocked',
        policyResult: 'fail: missing CostCenter, PO_ID; region not allowed',
        approvals: [],
        deployments: [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
      },
    ],
    budgets: [
      { costCenter: 'FIN001', monthlyLimit: baseBudget, spent: 480, forecast: 680, currency: 'AUD' },
      { costCenter: 'ENG001', monthlyLimit: 50000, spent: 12400, forecast: 15800, currency: 'AUD' },
    ],
    audit: [
      { at: nowIso(), action: 'seeded', actor: 'system', subject: 'APCL demo state initialized' },
    ],
  };
}

function loadState() {
  ensureDataDir();
  if (!fs.existsSync(DATA_FILE)) {
    const seed = seedState();
    fs.writeFileSync(DATA_FILE, JSON.stringify(seed, null, 2));
    return seed;
  }

  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  return JSON.parse(raw);
}

function saveState(state) {
  ensureDataDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

function send(res, statusCode, body, headers = {}) {
  const isObject = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  const payload = isObject ? JSON.stringify(body, null, 2) : String(body ?? '');
  res.writeHead(statusCode, {
    'Content-Type': isObject ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(filePath, res) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return false;
  }

  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.txt': 'text/plain; charset=utf-8',
  };

  res.writeHead(200, {
    'Content-Type': types[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

function calculateSummary(state) {
  const approved = state.requests.filter(r => r.state === 'approved' || r.state === 'deployed');
  const blocked = state.requests.filter(r => r.state === 'blocked' || r.state === 'rejected');
  const deployed = state.requests.filter(r => r.state === 'deployed');
  const totalForecast = state.budgets.reduce((sum, budget) => sum + Number(budget.forecast || 0), 0);
  const totalSpent = state.budgets.reduce((sum, budget) => sum + Number(budget.spent || 0), 0);
  const policyHitRate = state.requests.length ? Math.round((blocked.length / state.requests.length) * 100) : 0;

  return {
    counts: {
      requests: state.requests.length,
      approved: approved.length,
      blocked: blocked.length,
      deployed: deployed.length,
    },
    budgets: state.budgets,
    spend: {
      spent: totalSpent,
      forecast: totalForecast,
      currency: 'AUD',
    },
    governance: {
      policyHitRate,
      requiredTags: policyPack.requiredTags,
      allowedLocations: policyPack.allowedLocations,
      allowedVmSkus: policyPack.allowedVmSkus,
    },
  };
}

function validateRequest(input) {
  const required = ['title', 'requester', 'tenant', 'subscription', 'resourceType', 'region', 'sku', 'costCenter', 'poId', 'owner', 'estimatedMonthlyCost', 'justification'];
  const missing = required.filter(key => {
    const value = input[key];
    return value === undefined || value === null || String(value).trim() === '';
  });
  return missing;
}

function evaluateRequest(input) {
  const issues = [];
  if (!policyPack.allowedLocations.includes(String(input.region || '').toLowerCase())) {
    issues.push(`region not allowed (${input.region})`);
  }
  if (input.resourceType === 'Microsoft.Compute/virtualMachines' && !policyPack.allowedVmSkus.includes(String(input.sku || ''))) {
    issues.push(`VM SKU not allowed (${input.sku})`);
  }
  if (!input.costCenter) issues.push('missing CostCenter');
  if (!input.poId) issues.push('missing PO_ID');
  if (!input.owner) issues.push('missing Owner');
  return issues;
}

function nextRequestNumber(state) {
  const last = [...state.requests]
    .map(r => Number(String(r.number).split('-').pop()))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0] || 0;
  return `APCL-2026-${String(last + 1).padStart(4, '0')}`;
}

function handleApi(req, res, pathname) {
  const state = loadState();

  if (req.method === 'GET' && pathname === '/api/health') {
    return send(res, 200, { status: 'ok', time: nowIso() });
  }

  if (req.method === 'GET' && pathname === '/api/policy') {
    return send(res, 200, {
      packVersion: state.metadata.policyPackVersion,
      policyPack,
    });
  }

  if (req.method === 'GET' && pathname === '/api/summary') {
    return send(res, 200, calculateSummary(state));
  }

  if (req.method === 'GET' && pathname === '/api/requests') {
    return send(res, 200, { requests: state.requests.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)) });
  }

  if (req.method === 'POST' && pathname === '/api/requests') {
    return readJson(req)
      .then(body => {
        const missing = validateRequest(body);
        const request = {
          id: makeId('req'),
          number: nextRequestNumber(state),
          title: String(body.title).trim(),
          requester: String(body.requester).trim(),
          tenant: String(body.tenant).trim(),
          subscription: String(body.subscription).trim(),
          resourceType: String(body.resourceType).trim(),
          region: String(body.region).trim().toLowerCase(),
          sku: String(body.sku).trim(),
          costCenter: String(body.costCenter).trim(),
          poId: String(body.poId).trim(),
          owner: String(body.owner).trim(),
          estimatedMonthlyCost: Number(body.estimatedMonthlyCost),
          justification: String(body.justification).trim(),
          state: 'submitted',
          policyResult: '',
          approvals: [],
          deployments: [],
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };

        if (missing.length) {
          request.state = 'blocked';
          request.policyResult = `missing fields: ${missing.join(', ')}`;
        } else {
          const issues = evaluateRequest(request);
          if (issues.length) {
            request.state = 'blocked';
            request.policyResult = `fail: ${issues.join('; ')}`;
          } else {
            request.state = 'submitted';
            request.policyResult = 'pass';
          }
        }

        state.requests.unshift(request);
        state.audit.unshift({
          at: nowIso(),
          action: 'request-created',
          actor: request.requester,
          subject: request.number,
        });
        saveState(state);
        send(res, 201, { request });
      })
      .catch(err => send(res, 400, { error: err.message }));
  }

  const requestMatch = pathname.match(/^\/api\/requests\/([^/]+)(?:\/([^/]+))?$/);
  if (requestMatch) {
    const requestId = decodeURIComponent(requestMatch[1]);
    const action = requestMatch[2];
    const request = state.requests.find(r => r.id === requestId || r.number === requestId);
    if (!request) {
      return send(res, 404, { error: 'Request not found' });
    }

    if (req.method === 'POST' && !action) {
      return readJson(req)
        .then(body => {
          const issues = evaluateRequest({ ...request, ...body });
          request.policyResult = issues.length ? `fail: ${issues.join('; ')}` : 'pass';
          request.state = issues.length ? 'blocked' : 'submitted';
          request.updatedAt = nowIso();
          state.audit.unshift({ at: nowIso(), action: 'request-updated', actor: body.actor || 'system', subject: request.number });
          saveState(state);
          send(res, 200, { request });
        })
        .catch(err => send(res, 400, { error: err.message }));
    }

    if (req.method === 'POST' && action === 'decision') {
      return readJson(req)
        .then(body => {
          const decision = String(body.decision || '').toLowerCase();
          const comment = String(body.comment || '').trim();
          if (!['approved', 'rejected'].includes(decision)) {
            return send(res, 400, { error: 'decision must be approved or rejected' });
          }
          request.approvals.push({
            step: request.approvals.length + 1,
            approver: String(body.approver || 'unknown').trim(),
            decision,
            comment,
            at: nowIso(),
          });
          request.state = decision;
          request.updatedAt = nowIso();
          state.audit.unshift({
            at: nowIso(),
            action: `request-${decision}`,
            actor: String(body.approver || 'unknown').trim(),
            subject: request.number,
          });
          saveState(state);
          send(res, 200, { request });
        })
        .catch(err => send(res, 400, { error: err.message }));
    }

    if (req.method === 'POST' && action === 'deploy') {
      return readJson(req)
        .then(body => {
          if (request.state !== 'approved') {
            return send(res, 409, { error: 'request must be approved before deployment' });
          }
          const deployment = {
            id: makeId('dep'),
            name: String(body.name || `deploy-${request.number}`).trim(),
            deployedBy: String(body.deployedBy || 'pipeline@contoso.com').trim(),
            status: 'succeeded',
            at: nowIso(),
          };
          request.deployments.push(deployment);
          request.state = 'deployed';
          request.updatedAt = nowIso();

          const budget = state.budgets.find(b => b.costCenter === request.costCenter);
          if (budget) {
            budget.spent = Number(budget.spent || 0) + Number(request.estimatedMonthlyCost || 0);
            budget.forecast = Math.max(Number(budget.forecast || 0), budget.spent * 1.15);
          }

          state.audit.unshift({
            at: nowIso(),
            action: 'deployed',
            actor: deployment.deployedBy,
            subject: request.number,
          });
          saveState(state);
          send(res, 200, { request, deployment });
        })
        .catch(err => send(res, 400, { error: err.message }));
    }

    return send(res, 404, { error: 'Unknown request action' });
  }

  if (req.method === 'GET' && pathname === '/api/audit') {
    return send(res, 200, { audit: state.audit.slice(0, 100) });
  }

  return false;
}

function handler(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname || '/');

  if (pathname.startsWith('/api/')) {
    const handled = handleApi(req, res, pathname);
    if (handled !== false) {
      return;
    }
  }

  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? '/index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return send(res, 403, 'Forbidden');
  }
  if (pathname === '/') {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }

  if (!serveStatic(filePath, res)) {
    send(res, 404, 'Not found');
  }
}

const server = http.createServer(handler);

server.listen(PORT, () => {
  console.log(`APCL running at http://localhost:${PORT}`);
});
