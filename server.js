const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const { signToken, verifyToken } = require('./lib/entitlement');
const { appendAuditEvent: appendAuditEventInternal, hydrateAuditChain } = require('./lib/audit');
const { createStateStore } = require('./lib/state-store');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');
const SQLITE_DB_FILE = process.env.APCL_SQLITE_DB_PATH || path.join(DATA_DIR, 'apcl.db');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const ENTITLEMENT_SECRET = process.env.APCL_ENTITLEMENT_SECRET || 'apcl-dev-secret-change';
const ENTITLEMENT_TTL_MINUTES = Number(process.env.APCL_ENTITLEMENT_TTL_MINUTES || 60);
const DEPLOYMENT_MODE = String(process.env.APCL_DEPLOYMENT_MODE || 'local').toLowerCase(); // local | webhook
const DEPLOYMENT_WEBHOOK_URL = process.env.APCL_DEPLOYMENT_WEBHOOK_URL || '';
const DEPLOYMENT_WEBHOOK_HMAC_SECRET = process.env.APCL_DEPLOYMENT_WEBHOOK_HMAC_SECRET || '';
const DEPLOYMENT_STATUS_TOKEN = process.env.APCL_DEPLOYMENT_STATUS_TOKEN || '';
const STATE_BACKEND = String(process.env.APCL_STATE_BACKEND || 'file').toLowerCase(); // file | sqlite
const AUDIT_EXPORT_PATH = process.env.APCL_AUDIT_EXPORT_PATH || '';
const AUDIT_EXPORT_SECRET = process.env.APCL_AUDIT_EXPORT_SECRET || '';
const AUTH_MODE = String(process.env.APCL_AUTH_MODE || 'none').toLowerCase(); // none | easyauth | static
const STATIC_TOKEN_MAP = (() => {
  try {
    return JSON.parse(process.env.APCL_STATIC_TOKENS_JSON || '{}');
  } catch {
    return {};
  }
})();

const policyPack = {
  allowedLocations: ['australiaeast', 'australiasoutheast'],
  allowedVmSkus: ['Standard_D2s_v5', 'Standard_D4s_v5'],
  requiredTags: ['CostCenter', 'PO_ID', 'Owner', 'RequestId'],
};

function nowIso() {
  return new Date().toISOString();
}

function parseMsClientPrincipal(headerValue) {
  if (!headerValue) return null;
  try {
    const decoded = Buffer.from(String(headerValue), 'base64').toString('utf8');
    const principal = JSON.parse(decoded);
    const claims = Array.isArray(principal.claims) ? principal.claims : [];
    const claimValue = (...types) => {
      for (const type of types) {
        const found = claims.find(c => c.typ === type);
        if (found && found.val) return String(found.val);
      }
      return '';
    };
    const roles = claims
      .filter(c =>
        c.typ === 'roles'
        || c.typ === 'role'
        || c.typ === 'http://schemas.microsoft.com/ws/2008/06/identity/claims/role'
      )
      .map(c => String(c.val || '').toLowerCase())
      .filter(Boolean);
    const actor = claimValue(
      'preferred_username',
      'upn',
      'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn',
      'name'
    ) || 'unknown';
    return {
      authenticated: true,
      actor,
      roles,
      authSource: 'easyauth',
      principalId: claimValue('oid', 'http://schemas.microsoft.com/identity/claims/objectidentifier') || null,
    };
  } catch {
    return null;
  }
}

function getIdentity(req) {
  if (AUTH_MODE === 'none') {
    return {
      authenticated: true,
      actor: 'demo-user@local',
      roles: ['requester', 'procurement', 'finance', 'deployer', 'platform', 'security'],
      authSource: 'none',
      principalId: null,
    };
  }

  if (AUTH_MODE === 'easyauth') {
    const principalHeader = req.headers['x-ms-client-principal'];
    const principal = parseMsClientPrincipal(principalHeader);
    if (!principal) {
      return { authenticated: false, reason: 'missing or invalid EasyAuth principal header' };
    }
    return principal;
  }

  if (AUTH_MODE === 'static') {
    const authHeader = String(req.headers.authorization || '');
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!token) {
      return { authenticated: false, reason: 'missing bearer token' };
    }
    const mapped = STATIC_TOKEN_MAP[token];
    if (!mapped || !mapped.actor) {
      return { authenticated: false, reason: 'token not recognized' };
    }
    const roles = Array.isArray(mapped.roles)
      ? mapped.roles.map(r => String(r).toLowerCase())
      : [];
    return {
      authenticated: true,
      actor: String(mapped.actor),
      roles,
      authSource: 'static',
      principalId: mapped.principalId || null,
    };
  }

  return { authenticated: false, reason: `unsupported auth mode: ${AUTH_MODE}` };
}

function hasRequiredRole(identity, requiredRoles) {
  if (!requiredRoles || !requiredRoles.length) return true;
  const userRoles = Array.isArray(identity.roles) ? identity.roles : [];
  return requiredRoles.some(role => userRoles.includes(String(role).toLowerCase()));
}

function timingSafeEquals(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function hasValidDeploymentStatusToken(req) {
  if (!DEPLOYMENT_STATUS_TOKEN) return false;
  const supplied = String(req.headers['x-apcl-status-token'] || '').trim();
  return supplied && timingSafeEquals(supplied, DEPLOYMENT_STATUS_TOKEN);
}

const stateStore = createStateStore({
  dataDir: DATA_DIR,
  dataFile: DATA_FILE,
  sqliteDbPath: SQLITE_DB_FILE,
  backend: STATE_BACKEND,
  auditExportPath: AUDIT_EXPORT_PATH,
  auditExportSecret: AUDIT_EXPORT_SECRET,
});

function appendAuditEvent(state, event) {
  const entry = appendAuditEventInternal(state, event);
  stateStore.exportAudit(entry);
  return entry;
}

function nextExceptionNumber(request) {
  const last = [...(request.exceptions || [])]
    .map(e => Number(String(e.number || '').split('-').pop()))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0] || 0;
  return `EX-${String(last + 1).padStart(4, '0')}`;
}

function findOrCreateBudget(state, costCenter, monthlyLimit = 10000, currency = 'AUD', thresholds = [80, 100]) {
  let budget = (state.budgets || []).find(b => b.costCenter === costCenter);
  if (!budget) {
    budget = {
      costCenter,
      monthlyLimit,
      spent: 0,
      forecast: 0,
      currency,
      thresholds,
    };
    state.budgets.push(budget);
  }
  budget.thresholds = budget.thresholds || thresholds;
  return budget;
}

function nextAssignmentNumber(state) {
  const last = [...(state.assignments || [])]
    .map(a => Number(String(a.number || '').split('-').pop()))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0] || 0;
  return `ASN-${String(last + 1).padStart(4, '0')}`;
}

function deriveResourceGroupName(policy, request) {
  const safe = String(request.number || request.id).toLowerCase().replace(/[^a-z0-9-]/g, '');
  return `${policy.resourceGroupPrefix || 'rg-apcl'}-${safe}`.slice(0, 80);
}

function ensureAssignmentAndBudget(state, request, actor) {
  if (request.assignmentId) {
    const existing = state.assignments.find(a => a.id === request.assignmentId);
    if (existing) {
      findOrCreateBudget(
        state,
        request.costCenter,
        existing.budgetCap,
        'AUD',
        request.budgetThresholds && request.budgetThresholds.length ? request.budgetThresholds : state.config.defaultBudgetThresholds
      );
      return { assignment: existing, created: false };
    }
  }
  const policy = state.assignmentPolicies.find(p => p.costCenter === request.costCenter) || {
    costCenter: request.costCenter,
    subscription: request.subscription,
    resourceGroupPrefix: 'rg-apcl',
    monthlyBudgetCap: request.desiredBudgetCap || state.config.defaultBudgetCap || 10000,
  };
  const assignment = {
    id: makeId('asn'),
    number: nextAssignmentNumber(state),
    requestId: request.id,
    requestNumber: request.number,
    costCenter: request.costCenter,
    poId: request.poId,
    subscription: policy.subscription || request.subscription,
    resourceGroup: deriveResourceGroupName(policy, request),
    budgetCap: Number(request.desiredBudgetCap || policy.monthlyBudgetCap || state.config.defaultBudgetCap || 10000),
    status: 'assigned',
    assignedBy: actor,
    assignedAt: nowIso(),
  };
  state.assignments.unshift(assignment);
  request.assignmentId = assignment.id;
  findOrCreateBudget(
    state,
    request.costCenter,
    assignment.budgetCap,
    'AUD',
    request.budgetThresholds && request.budgetThresholds.length ? request.budgetThresholds : state.config.defaultBudgetThresholds
  );
  return { assignment, created: true };
}

function nextExecutionNumber(state) {
  const last = [...(state.deploymentExecutions || [])]
    .map(e => Number(String(e.number || '').split('-').pop()))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0] || 0;
  return `RUN-${String(last + 1).padStart(5, '0')}`;
}

async function triggerDeploymentExecution(state, request, assignment, body) {
  const execution = {
    id: makeId('run'),
    number: nextExecutionNumber(state),
    requestId: request.id,
    requestNumber: request.number,
    assignmentId: assignment.id,
    deploymentName: String(body.name || `deploy-${request.number}`).trim(),
    deployedBy: String(body.deployedBy || 'pipeline@contoso.com').trim(),
    mode: DEPLOYMENT_MODE,
    externalRunId: null,
    status: 'queued',
    startedAt: nowIso(),
    completedAt: null,
    resultMessage: null,
  };

  if (DEPLOYMENT_MODE === 'webhook') {
    if (!DEPLOYMENT_WEBHOOK_URL) {
      execution.status = 'failed';
      execution.resultMessage = 'APCL_DEPLOYMENT_WEBHOOK_URL not configured';
      return execution;
    }
    const webhookPayload = {
      request,
      assignment,
      executionId: execution.id,
    };
    const headers = { 'Content-Type': 'application/json' };
    if (DEPLOYMENT_WEBHOOK_HMAC_SECRET) {
      const ts = String(Math.floor(Date.now() / 1000));
      const serialized = JSON.stringify(webhookPayload);
      const signature = crypto
        .createHmac('sha256', DEPLOYMENT_WEBHOOK_HMAC_SECRET)
        .update(`${ts}.${serialized}`)
        .digest('hex');
      headers['x-apcl-timestamp'] = ts;
      headers['x-apcl-signature'] = signature;
    }
    const response = await fetch(DEPLOYMENT_WEBHOOK_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(webhookPayload),
    });
    if (!response.ok) {
      execution.status = 'failed';
      execution.resultMessage = `webhook trigger failed (${response.status})`;
      return execution;
    }
    const payload = await response.json().catch(() => ({}));
    execution.externalRunId = payload.runId || payload.id || execution.id;
    execution.status = 'queued';
    execution.resultMessage = 'queued via webhook';
    return execution;
  }

  execution.externalRunId = execution.id;
  execution.status = 'succeeded';
  execution.completedAt = nowIso();
  execution.resultMessage = 'completed via local adapter';
  return execution;
}

function finalizeDeploymentSuccess(state, request, execution, validation) {
  if ((request.deployments || []).some(d => d.executionId === execution.id)) {
    return;
  }
  const deployment = {
    id: makeId('dep'),
    name: execution.deploymentName,
    deployedBy: execution.deployedBy,
    status: 'succeeded',
    at: nowIso(),
    executionId: execution.id,
    externalRunId: execution.externalRunId,
  };
  request.deployments.push(deployment);
  request.state = 'deployed';
  request.updatedAt = nowIso();
  if (validation && validation.entitlement && !validation.entitlement.consumedAt) {
    validation.entitlement.consumedAt = nowIso();
  }

  const budget = findOrCreateBudget(state, request.costCenter);
  budget.spent = Number(budget.spent || 0) + Number(request.estimatedMonthlyCost || 0);
  budget.forecast = Math.max(Number(budget.forecast || 0), budget.spent * 1.15);
}

function calculateBudgetAlertKey(costCenter, threshold, period) {
  return `${costCenter}:${threshold}:${period}`;
}

function evaluateBudgetAlerts(state, source = 'runtime') {
  const period = new Date().toISOString().slice(0, 7);
  for (const budget of state.budgets || []) {
    const cap = Number(budget.monthlyLimit || 0);
    if (cap <= 0) continue;
    const spent = Number(budget.spent || 0);
    const pct = (spent / cap) * 100;
    for (const threshold of budget.thresholds || [80, 100]) {
      if (pct >= threshold) {
        const key = calculateBudgetAlertKey(budget.costCenter, threshold, period);
        const exists = (state.budgetAlerts || []).some(a => a.key === key);
        if (!exists) {
          state.budgetAlerts.unshift({
            key,
            costCenter: budget.costCenter,
            threshold,
            period,
            spent,
            cap,
            percent: Math.round(pct * 100) / 100,
            source,
            createdAt: nowIso(),
          });
        }
      }
    }
  }
}

function recalculateBudgetsFromReconciliation(state) {
  const totals = new Map();
  for (const row of state.reconciliation.rows || []) {
    if (!row.costCenter) continue;
    const prev = totals.get(row.costCenter) || 0;
    totals.set(row.costCenter, prev + Number(row.cost || 0));
  }
  for (const budget of state.budgets || []) {
    const spent = totals.get(budget.costCenter);
    if (spent !== undefined) {
      budget.spent = Math.round(spent * 100) / 100;
      budget.forecast = Math.round(budget.spent * 1.1 * 100) / 100;
    }
  }
  evaluateBudgetAlerts(state, 'reconciliation');
}

function summarizeChargeback(state) {
  const byCostCenter = {};
  const byPo = {};
  for (const row of state.reconciliation.rows || []) {
    const cc = row.costCenter || 'UNMAPPED';
    byCostCenter[cc] = (byCostCenter[cc] || 0) + Number(row.cost || 0);
    const po = row.poId || 'UNMAPPED';
    byPo[po] = (byPo[po] || 0) + Number(row.cost || 0);
  }
  return {
    byCostCenter: Object.entries(byCostCenter).map(([costCenter, cost]) => ({ costCenter, cost: Math.round(cost * 100) / 100 })),
    byPo: Object.entries(byPo).map(([poId, cost]) => ({ poId, cost: Math.round(cost * 100) / 100 })),
  };
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function seedState() {
  const baseBudget = 25000;
  return {
    metadata: {
      version: '1.1.0',
      createdAt: nowIso(),
      policyPackVersion: 'apcl-baseline-initiative@1.0.0',
      controlPlane: 'phase2',
    },
    config: {
      managerApproverEmail: 'manager@contoso.com',
      procurementApproverEmail: 'procurement@contoso.com',
      financeApproverEmail: 'finance@contoso.com',
      defaultBudgetCap: 10000,
      defaultBudgetThresholds: [80, 100],
      defaultExceptionDurationHours: 24,
    },
    tenants: [
      {
        id: 'tenant_contoso_prod',
        name: 'contoso-prod',
        subscriptions: ['sub-prod-finance', 'sub-prod-platform'],
        onboardedAt: nowIso(),
      },
    ],
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
        exceptions: [],
        entitlements: [],
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
        exceptions: [],
        entitlements: [],
        deployments: [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
      },
    ],
    budgets: [
      { costCenter: 'FIN001', monthlyLimit: baseBudget, spent: 480, forecast: 680, currency: 'AUD', thresholds: [80, 100] },
      { costCenter: 'ENG001', monthlyLimit: 50000, spent: 12400, forecast: 15800, currency: 'AUD', thresholds: [80, 100] },
    ],
    assignmentPolicies: [
      {
        costCenter: 'FIN001',
        subscription: 'sub-prod-finance',
        resourceGroupPrefix: 'rg-apcl-fin',
        monthlyBudgetCap: 25000,
      },
      {
        costCenter: 'ENG001',
        subscription: 'sub-prod-platform',
        resourceGroupPrefix: 'rg-apcl-eng',
        monthlyBudgetCap: 50000,
      },
    ],
    assignments: [],
    deploymentExecutions: [],
    budgetAlerts: [],
    reconciliation: {
      imports: [],
      rows: [],
      orphanSpend: [],
      chargebackSnapshots: [],
    },
    controls: {
      bypassProtection: {
        deploymentRequiresEntitlement: true,
        entitlementSingleUse: true,
        entitlementExpiryMinutes: ENTITLEMENT_TTL_MINUTES,
        deploymentMode: DEPLOYMENT_MODE,
      },
      policyPack: {
        assignmentMode: 'deny',
        requiredTags: [...policyPack.requiredTags],
      },
      rbacBaseline: {
        blockedHumanRoles: ['Owner', 'Contributor', 'User Access Administrator'],
      },
      exceptionWorkflow: {
        enabled: true,
        maxDurationHours: 72,
      },
    },
    audit: [],
  };
}

function loadState() {
  const parsed = stateStore.loadState(seedState, normalizeState);
  if (!Array.isArray(parsed.audit) || !parsed.audit.length) {
    appendAuditEvent(parsed, { at: nowIso(), action: 'seeded', actor: 'system', subject: 'APCL demo state initialized' });
    stateStore.saveState(parsed);
  }
  return parsed;
}

function normalizeState(parsed) {
  parsed.reconciliation = parsed.reconciliation || { imports: [], rows: [], orphanSpend: [] };
  parsed.reconciliation.chargebackSnapshots = parsed.reconciliation.chargebackSnapshots || [];
  parsed.config = parsed.config || {
    managerApproverEmail: 'manager@contoso.com',
    procurementApproverEmail: 'procurement@contoso.com',
    financeApproverEmail: 'finance@contoso.com',
    defaultBudgetCap: 10000,
    defaultBudgetThresholds: [80, 100],
    defaultExceptionDurationHours: 24,
  };
  parsed.config.defaultBudgetThresholds = Array.isArray(parsed.config.defaultBudgetThresholds) && parsed.config.defaultBudgetThresholds.length
    ? parsed.config.defaultBudgetThresholds.map(n => Number(n)).filter(Number.isFinite)
    : [80, 100];
  parsed.controls = parsed.controls || {
    bypassProtection: {
      deploymentRequiresEntitlement: true,
      entitlementSingleUse: true,
      entitlementExpiryMinutes: ENTITLEMENT_TTL_MINUTES,
      deploymentMode: DEPLOYMENT_MODE,
    },
    policyPack: {
      assignmentMode: 'deny',
      requiredTags: [...policyPack.requiredTags],
    },
    rbacBaseline: {
      blockedHumanRoles: ['Owner', 'Contributor', 'User Access Administrator'],
    },
    exceptionWorkflow: {
      enabled: true,
      maxDurationHours: 72,
    },
  };
  parsed.assignmentPolicies = parsed.assignmentPolicies || [];
  parsed.assignments = parsed.assignments || [];
  parsed.deploymentExecutions = parsed.deploymentExecutions || [];
  parsed.budgetAlerts = parsed.budgetAlerts || [];
  parsed.tenants = parsed.tenants || [];
  for (const request of parsed.requests || []) {
    request.entitlements = request.entitlements || [];
    request.exceptions = request.exceptions || [];
    request.assignmentId = request.assignmentId || null;
    request.managerApproverEmail = request.managerApproverEmail || parsed.config.managerApproverEmail;
    request.procurementApproverEmail = request.procurementApproverEmail || parsed.config.procurementApproverEmail;
    request.financeApproverEmail = request.financeApproverEmail || parsed.config.financeApproverEmail;
    request.desiredBudgetCap = Number(request.desiredBudgetCap || parsed.config.defaultBudgetCap);
    request.budgetThresholds = Array.isArray(request.budgetThresholds) && request.budgetThresholds.length
      ? request.budgetThresholds.map(n => Number(n)).filter(Number.isFinite)
      : [...parsed.config.defaultBudgetThresholds];
  }
  for (const budget of parsed.budgets || []) {
    budget.thresholds = budget.thresholds || [80, 100];
  }
  parsed.audit = hydrateAuditChain(parsed.audit || []);
  return parsed;
}

function saveState(state) {
  stateStore.saveState(state);
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
    reconciliation: summarizeReconciliation(state),
    budgetAlerts: (state.budgetAlerts || []).slice(0, 20),
  };
}

function validateRequest(input) {
  const required = [
    'title',
    'tenant',
    'subscription',
    'resourceType',
    'region',
    'sku',
    'costCenter',
    'poId',
    'owner',
    'managerApproverEmail',
    'procurementApproverEmail',
    'desiredBudgetCap',
    'estimatedMonthlyCost',
    'justification',
  ];
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

function issueEntitlementForRequest(request, issuedBy) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + ENTITLEMENT_TTL_MINUTES * 60;
  const tokenId = makeId('ent');
  const payload = {
    jti: tokenId,
    requestId: request.id,
    requestNumber: request.number,
    subscription: request.subscription,
    region: request.region,
    sku: request.sku,
    costCenter: request.costCenter,
    poId: request.poId,
    iat: issuedAt,
    exp: expiresAt,
  };
  const token = signToken(payload, ENTITLEMENT_SECRET);
  return {
    token,
    record: {
      id: tokenId,
      issuedBy,
      issuedAt: nowIso(),
      expiresAt: new Date(expiresAt * 1000).toISOString(),
      consumedAt: null,
    },
  };
}

function validateDeployEntitlement(request, token) {
  const result = verifyToken(token, ENTITLEMENT_SECRET);
  if (!result.valid) {
    return { ok: false, reason: result.reason };
  }
  const payload = result.payload;
  if (payload.requestId !== request.id || payload.requestNumber !== request.number) {
    return { ok: false, reason: 'token request mismatch' };
  }
  const entitlement = (request.entitlements || []).find(e => e.id === payload.jti);
  if (!entitlement) {
    return { ok: false, reason: 'token not issued by APCL for this request' };
  }
  if (entitlement.consumedAt) {
    return { ok: false, reason: 'token already used' };
  }
  if (entitlement.expiresAt && Date.now() > new Date(entitlement.expiresAt).getTime()) {
    return { ok: false, reason: 'token expired' };
  }
  return { ok: true, payload, entitlement };
}

function hasActiveException(request) {
  const now = Date.now();
  return (request.exceptions || []).some(e => e.status === 'approved' && new Date(e.expiresAt).getTime() > now);
}

function summarizeReconciliation(state) {
  const rows = state.reconciliation.rows || [];
  const imported = rows.length;
  const matched = rows.filter(r => r.matchStatus === 'matched').length;
  const orphan = rows.filter(r => r.matchStatus === 'orphan').length;
  const totalCost = rows.reduce((sum, r) => sum + Number(r.cost || 0), 0);
  return {
    importedRows: imported,
    matchedRows: matched,
    orphanRows: orphan,
    totalCost,
    orphanSpend: state.reconciliation.orphanSpend || [],
    lastImport: (state.reconciliation.imports || [])[0] || null,
    chargeback: summarizeChargeback(state),
  };
}

function handleApi(req, res, pathname) {
  const state = loadState();
  const deploymentStatusPath = /^\/api\/deployments\/[^/]+\/status$/.test(pathname);
  const callbackTokenValid = deploymentStatusPath && hasValidDeploymentStatusToken(req);
  const identity = callbackTokenValid
    ? {
      authenticated: true,
      actor: 'orchestrator-callback',
      roles: ['deployer', 'platform'],
      authSource: 'status-token',
      principalId: null,
    }
    : getIdentity(req);

  if (pathname !== '/api/health') {
    if (!identity.authenticated) {
      return send(res, 401, { error: `authentication required: ${identity.reason || 'unauthorized'}` });
    }
  }

  const requireRoles = roles => {
    if (!hasRequiredRole(identity, roles)) {
      send(res, 403, {
        error: `forbidden: requires one of roles [${roles.join(', ')}]`,
        actor: identity.actor,
      });
      return false;
    }
    return true;
  };

  if (req.method === 'GET' && pathname === '/api/health') {
    return send(res, 200, {
      status: 'ok',
      time: nowIso(),
      authMode: AUTH_MODE,
      stateBackend: STATE_BACKEND,
      deploymentMode: DEPLOYMENT_MODE,
    });
  }

  if (req.method === 'GET' && pathname === '/api/policy') {
    return send(res, 200, {
      packVersion: state.metadata.policyPackVersion,
      policyPack,
    });
  }

  if (req.method === 'GET' && pathname === '/api/config') {
    return send(res, 200, { config: state.config });
  }

  if (req.method === 'PUT' && pathname === '/api/config') {
    if (!requireRoles(['platform'])) return;
    return readJson(req)
      .then(body => {
        const next = {
          managerApproverEmail: String(body.managerApproverEmail || state.config.managerApproverEmail).trim(),
          procurementApproverEmail: String(body.procurementApproverEmail || state.config.procurementApproverEmail).trim(),
          financeApproverEmail: String(body.financeApproverEmail || state.config.financeApproverEmail).trim(),
          defaultBudgetCap: Number(body.defaultBudgetCap ?? state.config.defaultBudgetCap),
          defaultBudgetThresholds: Array.isArray(body.defaultBudgetThresholds) && body.defaultBudgetThresholds.length
            ? body.defaultBudgetThresholds.map(n => Number(n)).filter(Number.isFinite)
            : state.config.defaultBudgetThresholds,
          defaultExceptionDurationHours: Number(body.defaultExceptionDurationHours ?? state.config.defaultExceptionDurationHours),
        };
        if (!next.defaultBudgetThresholds.length) {
          return send(res, 400, { error: 'defaultBudgetThresholds must contain at least one numeric value' });
        }
        if (!Number.isFinite(next.defaultBudgetCap) || next.defaultBudgetCap <= 0) {
          return send(res, 400, { error: 'defaultBudgetCap must be > 0' });
        }
        if (!Number.isFinite(next.defaultExceptionDurationHours) || next.defaultExceptionDurationHours <= 0) {
          return send(res, 400, { error: 'defaultExceptionDurationHours must be > 0' });
        }
        state.config = next;
        appendAuditEvent(state, {
          at: nowIso(),
          action: 'config-updated',
          actor: identity.actor,
          subject: 'control-plane-config',
          details: { authSource: identity.authSource || AUTH_MODE },
        });
        saveState(state);
        send(res, 200, { config: state.config });
      })
      .catch(err => send(res, 400, { error: err.message }));
  }

  if (req.method === 'GET' && pathname === '/api/summary') {
    return send(res, 200, calculateSummary(state));
  }

  if (req.method === 'GET' && pathname === '/api/control-plane/status') {
    return send(res, 200, {
      metadata: state.metadata,
      config: state.config,
      controls: state.controls,
      runtime: {
        authMode: AUTH_MODE,
        stateBackend: STATE_BACKEND,
        deploymentMode: DEPLOYMENT_MODE,
        deploymentStatusTokenConfigured: Boolean(DEPLOYMENT_STATUS_TOKEN),
        deploymentWebhookSignatureEnabled: Boolean(DEPLOYMENT_WEBHOOK_HMAC_SECRET),
      },
      tenants: state.tenants,
      assignments: {
        total: state.assignments.length,
      },
      deployments: {
        totalExecutions: state.deploymentExecutions.length,
      },
      reconciliation: summarizeReconciliation(state),
    });
  }

  if (req.method === 'GET' && pathname === '/api/assignments') {
    return send(res, 200, { assignments: state.assignments });
  }

  if (req.method === 'GET' && pathname === '/api/deployments') {
    return send(res, 200, { deployments: state.deploymentExecutions });
  }

  const deploymentStatusMatch = pathname.match(/^\/api\/deployments\/([^/]+)\/status$/);
  if (deploymentStatusMatch && req.method === 'POST') {
    if (!requireRoles(['deployer', 'platform'])) return;
    const executionRef = decodeURIComponent(deploymentStatusMatch[1]);
    return readJson(req)
      .then(body => {
        const nextStatus = String(body.status || '').toLowerCase();
        if (!['queued', 'running', 'succeeded', 'failed'].includes(nextStatus)) {
          return send(res, 400, { error: 'status must be queued, running, succeeded, or failed' });
        }
        const execution = (state.deploymentExecutions || []).find(e =>
          e.id === executionRef || e.number === executionRef || e.externalRunId === executionRef
        );
        if (!execution) {
          return send(res, 404, { error: 'deployment execution not found' });
        }
        execution.status = nextStatus;
        execution.resultMessage = String(body.resultMessage || execution.resultMessage || '').trim() || null;
        execution.externalRunId = String(body.externalRunId || execution.externalRunId || '').trim() || null;
        if (nextStatus === 'succeeded' || nextStatus === 'failed') {
          execution.completedAt = nowIso();
        }

        const request = state.requests.find(r => r.id === execution.requestId);
        if (request && nextStatus === 'succeeded' && request.state !== 'deployed') {
          const assignment = state.assignments.find(a => a.id === execution.assignmentId);
          if (assignment) {
            finalizeDeploymentSuccess(state, request, execution, { entitlement: null });
            evaluateBudgetAlerts(state, 'deployment');
          }
        }

        appendAuditEvent(state, {
          at: nowIso(),
          action: `deployment-status-${nextStatus}`,
          actor: identity.actor,
          subject: execution.requestNumber,
          details: {
            executionId: execution.id,
            externalRunId: execution.externalRunId,
            resultMessage: execution.resultMessage,
          },
        });
        saveState(state);
        send(res, 200, { execution });
      })
      .catch(err => send(res, 400, { error: err.message }));
  }

  if (req.method === 'GET' && pathname === '/api/requests') {
    return send(res, 200, { requests: state.requests.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)) });
  }

  if (req.method === 'POST' && pathname === '/api/requests') {
    if (!requireRoles(['requester', 'procurement', 'platform'])) return;
    return readJson(req)
      .then(body => {
        const missing = validateRequest(body);
        const request = {
          id: makeId('req'),
          number: nextRequestNumber(state),
          title: String(body.title).trim(),
          requester: identity.actor,
          tenant: String(body.tenant).trim(),
          subscription: String(body.subscription).trim(),
          resourceType: String(body.resourceType).trim(),
          region: String(body.region).trim().toLowerCase(),
          sku: String(body.sku).trim(),
          costCenter: String(body.costCenter).trim(),
          poId: String(body.poId).trim(),
          owner: String(body.owner).trim(),
          managerApproverEmail: String(body.managerApproverEmail || state.config.managerApproverEmail).trim(),
          procurementApproverEmail: String(body.procurementApproverEmail || state.config.procurementApproverEmail).trim(),
          financeApproverEmail: String(body.financeApproverEmail || state.config.financeApproverEmail).trim(),
          desiredBudgetCap: Number(body.desiredBudgetCap || state.config.defaultBudgetCap),
          budgetThresholds: Array.isArray(body.budgetThresholds) && body.budgetThresholds.length
            ? body.budgetThresholds.map(n => Number(n)).filter(Number.isFinite)
            : [...state.config.defaultBudgetThresholds],
          estimatedMonthlyCost: Number(body.estimatedMonthlyCost),
          justification: String(body.justification).trim(),
          state: 'submitted',
          policyResult: '',
          approvals: [],
          exceptions: [],
          entitlements: [],
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
        appendAuditEvent(state, {
          at: nowIso(),
          action: 'request-created',
          actor: identity.actor,
          subject: request.number,
          details: { authSource: identity.authSource || AUTH_MODE },
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
      if (!requireRoles(['requester', 'procurement', 'platform'])) return;
      return readJson(req)
        .then(body => {
          const issues = evaluateRequest({ ...request, ...body });
          request.policyResult = issues.length ? `fail: ${issues.join('; ')}` : 'pass';
          request.state = issues.length ? 'blocked' : 'submitted';
          request.updatedAt = nowIso();
          appendAuditEvent(state, {
            at: nowIso(),
            action: 'request-updated',
            actor: identity.actor,
            subject: request.number,
          });
          saveState(state);
          send(res, 200, { request });
        })
        .catch(err => send(res, 400, { error: err.message }));
    }

    if (req.method === 'POST' && action === 'decision') {
      if (!requireRoles(['procurement', 'platform'])) return;
      return readJson(req)
        .then(body => {
          const decision = String(body.decision || '').toLowerCase();
          const comment = String(body.comment || '').trim();
          const approver = identity.actor;
          if (!['approved', 'rejected'].includes(decision)) {
            return send(res, 400, { error: 'decision must be approved or rejected' });
          }
          request.approvals.push({
            step: request.approvals.length + 1,
            approver,
            decision,
            comment,
            at: nowIso(),
          });
          request.state = decision;
          request.updatedAt = nowIso();
          if (decision === 'approved') {
            const assigned = ensureAssignmentAndBudget(state, request, approver);
            if (assigned.created) {
              appendAuditEvent(state, {
                at: nowIso(),
                action: 'assignment-created',
                actor: approver,
                subject: `${request.number}:${assigned.assignment.number}`,
                details: {
                  subscription: assigned.assignment.subscription,
                  resourceGroup: assigned.assignment.resourceGroup,
                  budgetCap: assigned.assignment.budgetCap,
                },
              });
            }
          }
          appendAuditEvent(state, {
            at: nowIso(),
            action: `request-${decision}`,
            actor: approver,
            subject: request.number,
          });
          saveState(state);
          send(res, 200, { request });
        })
        .catch(err => send(res, 400, { error: err.message }));
    }

    if (req.method === 'POST' && action === 'deploy') {
      if (!requireRoles(['deployer', 'platform'])) return;
      return readJson(req)
        .then(async body => {
          const exceptionActive = hasActiveException(request);
          if (request.state !== 'approved' && !exceptionActive) {
            return send(res, 409, { error: 'request must be approved or have an active exception before deployment' });
          }
          const assignmentResult = ensureAssignmentAndBudget(
            state,
            request,
            identity.actor
          );
          const assignment = assignmentResult.assignment;
          const entitlementToken = String(body.entitlementToken || '').trim();
          const validation = validateDeployEntitlement(request, entitlementToken);
          if (!validation.ok) {
            return send(res, 403, { error: `deployment denied: ${validation.reason}` });
          }
          const consumed = stateStore.tryConsumeEntitlement(request, validation.entitlement, identity.actor);
          if (!consumed) {
            return send(res, 409, { error: 'deployment denied: entitlement token already consumed' });
          }
          const execution = await triggerDeploymentExecution(state, request, assignment, {
            ...body,
            deployedBy: identity.actor,
          });
          state.deploymentExecutions.unshift(execution);

          if (execution.status === 'succeeded') {
            finalizeDeploymentSuccess(state, request, execution, validation);
            evaluateBudgetAlerts(state, 'deployment');
            appendAuditEvent(state, {
              at: nowIso(),
              action: 'deployed',
              actor: identity.actor,
              subject: request.number,
              details: {
                assignmentId: assignment.id,
                executionId: execution.id,
              },
            });
            saveState(state);
            return send(res, 200, {
              request,
              deployment: request.deployments[request.deployments.length - 1],
              assignment,
              execution,
            });
          }

          if (execution.status === 'queued' || execution.status === 'running') {
            request.updatedAt = nowIso();
            appendAuditEvent(state, {
              at: nowIso(),
              action: 'deployment-queued',
              actor: identity.actor,
              subject: request.number,
              details: {
                assignmentId: assignment.id,
                executionId: execution.id,
                externalRunId: execution.externalRunId,
              },
            });
            saveState(state);
            return send(res, 202, { request, assignment, execution });
          }

          appendAuditEvent(state, {
            at: nowIso(),
            action: 'deployment-failed',
            actor: identity.actor,
            subject: request.number,
            details: {
              assignmentId: assignment.id,
              executionId: execution.id,
              resultMessage: execution.resultMessage,
            },
          });
          saveState(state);
          return send(res, 502, { error: execution.resultMessage || 'deployment execution failed', execution });
        })
        .catch(err => send(res, 400, { error: err.message }));
    }

    if (req.method === 'POST' && action === 'entitlement') {
      if (!requireRoles(['procurement', 'platform'])) return;
      return readJson(req)
        .then(body => {
          const exceptionActive = hasActiveException(request);
          if (request.state !== 'approved' && !exceptionActive) {
            return send(res, 409, { error: 'request must be approved or have an active exception before entitlement issuance' });
          }
          const issuedBy = identity.actor;
          const issued = issueEntitlementForRequest(request, issuedBy);
          request.entitlements = request.entitlements || [];
          request.entitlements.push(issued.record);
          request.updatedAt = nowIso();
          appendAuditEvent(state, {
            at: nowIso(),
            action: 'entitlement-issued',
            actor: issuedBy,
            subject: request.number,
          });
          saveState(state);
          send(res, 200, {
            entitlementToken: issued.token,
            entitlement: issued.record,
            request: {
              id: request.id,
              number: request.number,
              state: request.state,
            },
          });
        })
        .catch(err => send(res, 400, { error: err.message }));
    }

    if (req.method === 'POST' && action === 'assign') {
      if (!requireRoles(['procurement', 'platform'])) return;
      return readJson(req)
        .then(body => {
          const actor = identity.actor;
          const assigned = ensureAssignmentAndBudget(state, request, actor);
          request.updatedAt = nowIso();
          appendAuditEvent(state, {
            at: nowIso(),
            action: assigned.created ? 'assignment-created' : 'assignment-reused',
            actor,
            subject: `${request.number}:${assigned.assignment.number}`,
          });
          saveState(state);
          send(res, 200, { assignment: assigned.assignment, created: assigned.created, request });
        })
        .catch(err => send(res, 400, { error: err.message }));
    }

    if (req.method === 'POST' && action === 'exception') {
      if (!requireRoles(['requester', 'procurement', 'platform'])) return;
      return readJson(req)
        .then(body => {
          const requestedBy = identity.actor;
          const reason = String(body.reason || '').trim();
          const durationHours = Number(body.durationHours || state.config.defaultExceptionDurationHours || 24);
          if (!reason) {
            return send(res, 400, { error: 'exception reason is required' });
          }
          if (!Number.isFinite(durationHours) || durationHours <= 0 || durationHours > state.controls.exceptionWorkflow.maxDurationHours) {
            return send(res, 400, { error: `durationHours must be between 1 and ${state.controls.exceptionWorkflow.maxDurationHours}` });
          }
          request.exceptions = request.exceptions || [];
          const exception = {
            id: makeId('exc'),
            number: nextExceptionNumber(request),
            requestedBy,
            reason,
            durationHours,
            status: 'requested',
            requestedAt: nowIso(),
            approvedBy: null,
            approvedAt: null,
            expiresAt: null,
            rejectedBy: null,
            rejectedAt: null,
            rejectionReason: null,
          };
          request.exceptions.push(exception);
          request.updatedAt = nowIso();
          appendAuditEvent(state, {
            at: nowIso(),
            action: 'exception-requested',
            actor: requestedBy,
            subject: `${request.number}:${exception.number}`,
            details: { reason, durationHours },
          });
          saveState(state);
          send(res, 201, { exception, requestId: request.id, requestNumber: request.number });
        })
        .catch(err => send(res, 400, { error: err.message }));
    }

    if (req.method === 'POST' && action === 'exception-decision') {
      if (!requireRoles(['procurement', 'platform'])) return;
      return readJson(req)
        .then(body => {
          const exceptionId = String(body.exceptionId || '').trim();
          const decision = String(body.decision || '').trim().toLowerCase();
          const approver = identity.actor;
          const reason = String(body.reason || '').trim();
          if (!exceptionId) {
            return send(res, 400, { error: 'exceptionId is required' });
          }
          if (!['approved', 'rejected'].includes(decision)) {
            return send(res, 400, { error: 'decision must be approved or rejected' });
          }
          const exception = (request.exceptions || []).find(e => e.id === exceptionId || e.number === exceptionId);
          if (!exception) {
            return send(res, 404, { error: 'exception not found' });
          }
          if (exception.status !== 'requested') {
            return send(res, 409, { error: 'exception is already decided' });
          }
          if (decision === 'approved') {
            exception.status = 'approved';
            exception.approvedBy = approver;
            exception.approvedAt = nowIso();
            exception.expiresAt = new Date(Date.now() + exception.durationHours * 3600 * 1000).toISOString();
          } else {
            exception.status = 'rejected';
            exception.rejectedBy = approver;
            exception.rejectedAt = nowIso();
            exception.rejectionReason = reason || 'no reason provided';
          }
          request.updatedAt = nowIso();
          appendAuditEvent(state, {
            at: nowIso(),
            action: `exception-${decision}`,
            actor: approver,
            subject: `${request.number}:${exception.number}`,
            details: decision === 'approved' ? { expiresAt: exception.expiresAt } : { rejectionReason: exception.rejectionReason },
          });
          saveState(state);
          send(res, 200, { exception, requestId: request.id, requestNumber: request.number });
        })
        .catch(err => send(res, 400, { error: err.message }));
    }

    return send(res, 404, { error: 'Unknown request action' });
  }

  if (req.method === 'GET' && pathname === '/api/audit') {
    return send(res, 200, { audit: state.audit.slice(0, 100) });
  }

  if (req.method === 'POST' && pathname === '/api/reconciliation/import') {
    if (!requireRoles(['finance', 'platform'])) return;
    return readJson(req)
      .then(body => {
        const rows = Array.isArray(body.rows) ? body.rows : [];
        if (!rows.length) {
          return send(res, 400, { error: 'rows array is required' });
        }
        const importId = makeId('imp');
        const importedAt = nowIso();
        const normalized = rows.map((row, idx) => {
          const requestRef = String(row.requestNumber || '').trim();
          const cost = Number(row.cost || 0);
          const hasRequest = state.requests.some(r => r.number === requestRef);
          const matchStatus = hasRequest ? 'matched' : 'orphan';
          return {
            id: `${importId}_${idx + 1}`,
            importId,
            importedAt,
            requestNumber: requestRef || null,
            costCenter: String(row.costCenter || '').trim() || null,
            poId: String(row.poId || '').trim() || null,
            cost,
            currency: String(row.currency || 'AUD').trim(),
            source: String(row.source || 'manual-import').trim(),
            matchStatus,
          };
        });
        state.reconciliation.rows = [...normalized, ...(state.reconciliation.rows || [])].slice(0, 5000);
        state.reconciliation.orphanSpend = normalized
          .filter(r => r.matchStatus === 'orphan')
          .map(r => ({
            importId: r.importId,
            requestNumber: r.requestNumber,
            costCenter: r.costCenter,
            poId: r.poId,
            cost: r.cost,
            currency: r.currency,
          }));
        state.reconciliation.imports = [
          {
            id: importId,
            importedAt,
            rowCount: normalized.length,
            matched: normalized.filter(r => r.matchStatus === 'matched').length,
            orphan: normalized.filter(r => r.matchStatus === 'orphan').length,
          },
          ...(state.reconciliation.imports || []),
        ].slice(0, 200);
        recalculateBudgetsFromReconciliation(state);
        state.reconciliation.chargebackSnapshots.unshift({
          id: makeId('chg'),
          at: nowIso(),
          summary: summarizeChargeback(state),
        });
        appendAuditEvent(state, {
          at: nowIso(),
          action: 'reconciliation-imported',
          actor: identity.actor,
          subject: importId,
          details: {
            rows: normalized.length,
            matched: normalized.filter(r => r.matchStatus === 'matched').length,
            orphan: normalized.filter(r => r.matchStatus === 'orphan').length,
          },
        });
        saveState(state);
        send(res, 201, {
          importId,
          summary: summarizeReconciliation(state),
        });
      })
      .catch(err => send(res, 400, { error: err.message }));
  }

  if (req.method === 'GET' && pathname === '/api/reconciliation/summary') {
    return send(res, 200, summarizeReconciliation(state));
  }

  if (req.method === 'POST' && pathname === '/api/reconciliation/run') {
    if (!requireRoles(['finance', 'platform'])) return;
    recalculateBudgetsFromReconciliation(state);
    state.reconciliation.chargebackSnapshots.unshift({
      id: makeId('chg'),
      at: nowIso(),
      summary: summarizeChargeback(state),
    });
    appendAuditEvent(state, {
      at: nowIso(),
      action: 'reconciliation-run',
      actor: identity.actor,
      subject: 'manual-reconciliation-run',
    });
    saveState(state);
    return send(res, 200, summarizeReconciliation(state));
  }

  if (req.method === 'GET' && pathname === '/api/chargeback/summary') {
    return send(res, 200, summarizeChargeback(state));
  }

  if (req.method === 'POST' && pathname === '/api/rbac/drift-report') {
    if (!requireRoles(['security', 'platform'])) return;
    return readJson(req)
      .then(body => {
        const assignments = Array.isArray(body.assignments) ? body.assignments : [];
        const blockedRoles = state.controls.rbacBaseline.blockedHumanRoles || ['Owner', 'Contributor', 'User Access Administrator'];
        const findings = assignments
          .filter(a => String(a.principalType || '').toLowerCase() === 'user' && blockedRoles.includes(String(a.roleDefinitionName || a.role || '')))
          .map(a => ({
            principalId: a.principalId || a.assigneeObjectId || 'unknown',
            principalType: a.principalType,
            role: a.roleDefinitionName || a.role,
            scope: a.scope || 'unknown',
            severity: 'high',
            recommendation: 'Remove standing role and convert to eligible access with approvals.',
          }));
        const report = {
          generatedAt: nowIso(),
          assignmentCount: assignments.length,
          blockedRoles,
          findingCount: findings.length,
          findings,
        };
        appendAuditEvent(state, {
          at: nowIso(),
          action: 'rbac-drift-report',
          actor: identity.actor,
          subject: `findings:${findings.length}`,
        });
        saveState(state);
        send(res, 200, report);
      })
      .catch(err => send(res, 400, { error: err.message }));
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

if (process.env.NODE_ENV === 'production') {
  if (ENTITLEMENT_SECRET === 'apcl-dev-secret-change') {
    throw new Error('APCL_ENTITLEMENT_SECRET must be set to a strong non-default value in production.');
  }
  if (AUTH_MODE === 'none') {
    throw new Error('APCL_AUTH_MODE=none is not allowed in production.');
  }
}

const server = http.createServer(handler);

server.listen(PORT, () => {
  console.log(`APCL running at http://localhost:${PORT}`);
});
