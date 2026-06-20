const state = {
  requests: [],
  summary: null,
  policy: null,
  config: null,
  identity: null,
  activeView: 'procurement',
};

const el = id => document.getElementById(id);

function formatCurrency(amount, currency = 'AUD') {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency }).format(Number(amount || 0));
}

function badgeForStatus(status) {
  const cls = ['approved', 'deployed'].includes(status) ? 'good' : ['blocked', 'rejected'].includes(status) ? 'bad' : 'warn';
  return `<span class="badge ${cls}">${status}</span>`;
}

function getActionRole(action) {
  if (['approve', 'reject', 'exception-approve'].includes(action)) return 'procurement';
  if (action === 'exception') return 'engineer';
  if (action === 'deploy') return 'platform';
  return 'all';
}

function allowedInView(actionRole, activeView) {
  if (activeView === 'all') return true;
  if (actionRole === 'all') return true;
  return actionRole === activeView;
}

function renderIdentity() {
  const pill = el('identity-pill');
  if (!pill) return;
  if (!state.identity) {
    pill.textContent = 'Identity unavailable';
    return;
  }
  const roles = Array.isArray(state.identity.roles) ? state.identity.roles.join(', ') : '';
  pill.textContent = `${state.identity.actor} | ${roles || 'no roles'}`;
}

function setActiveView(nextView) {
  state.activeView = nextView;
  document.querySelectorAll('.view-btn').forEach(button => {
    button.classList.toggle('active', button.dataset.view === state.activeView);
  });
  document.querySelectorAll('[data-section]').forEach(section => {
    const visibility = String(section.dataset.section || '').split(/\s+/).filter(Boolean);
    const isVisible = state.activeView === 'all' || visibility.includes(state.activeView);
    section.style.display = isVisible ? '' : 'none';
  });
  renderRequests();
}

async function api(path, options) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
  return data;
}

function renderSummary() {
  if (!state.summary) return;
  el('stat-requests').textContent = state.summary.counts.requests;
  el('stat-approved').textContent = state.summary.counts.approved;
  el('stat-deployed').textContent = state.summary.counts.deployed;

  el('policy').innerHTML = `
    <div class="policy">
      <div class="badge good">Pack ${state.policy.packVersion}</div>
      <code>${JSON.stringify(state.policy.policyPack, null, 2)}</code>
    </div>
  `;

  el('budgets').innerHTML = (state.summary.budgets || []).map(budget => `
    <div class="budget-item">
      <strong>${budget.costCenter}</strong>
      <div class="muted">${formatCurrency(budget.spent, budget.currency)} spent / ${formatCurrency(budget.monthlyLimit, budget.currency)} limit</div>
    </div>
  `).join('');
}

function renderConfigForm() {
  if (!state.config) return;
  const form = el('config-form');
  form.managerApproverEmail.value = state.config.managerApproverEmail || '';
  form.procurementApproverEmail.value = state.config.procurementApproverEmail || '';
  form.financeApproverEmail.value = state.config.financeApproverEmail || '';
  form.defaultBudgetCap.value = state.config.defaultBudgetCap || 10000;
  form.defaultExceptionDurationHours.value = state.config.defaultExceptionDurationHours || 24;
  form.defaultBudgetThresholds.value = (state.config.defaultBudgetThresholds || [80, 100]).join(',');

  const requestForm = el('request-form');
  requestForm.managerApproverEmail.value = state.config.managerApproverEmail || '';
  requestForm.procurementApproverEmail.value = state.config.procurementApproverEmail || '';
  requestForm.desiredBudgetCap.value = state.config.defaultBudgetCap || 10000;
  requestForm.budgetThresholdsCsv.value = (state.config.defaultBudgetThresholds || [80, 100]).join(',');
}

function requestCard(request) {
  const latestException = (request.exceptions || [])[request.exceptions.length - 1];
  const exceptionLine = latestException
    ? `<div class="muted">Exception ${latestException.number}: ${latestException.status}${latestException.expiresAt ? ` (expires ${latestException.expiresAt})` : ''}</div>`
    : '';
  const thresholds = (request.budgetThresholds || []).length ? `${(request.budgetThresholds || []).join('%, ')}%` : 'n/a';
  const budgetLine = `<div class="muted">Budget cap: ${formatCurrency(request.desiredBudgetCap || 0)} | Thresholds: ${thresholds}</div>`;
  const approveHidden = allowedInView(getActionRole('approve'), state.activeView) ? '' : 'hidden';
  const rejectHidden = allowedInView(getActionRole('reject'), state.activeView) ? '' : 'hidden';
  const exceptionHidden = allowedInView(getActionRole('exception'), state.activeView) ? '' : 'hidden';
  const exceptionApproveHidden = allowedInView(getActionRole('exception-approve'), state.activeView) ? '' : 'hidden';
  const deployHidden = allowedInView(getActionRole('deploy'), state.activeView) ? '' : 'hidden';

  return `
    <article class="request-card">
      <div class="request-top">
        <strong>${request.number}</strong>
        ${badgeForStatus(request.state)}
        <span class="muted">${request.title}</span>
      </div>
      <div class="request-meta muted">
        <span>${request.requester}</span>
        <span>${request.subscription}</span>
        <span>${request.region}</span>
        <span>${request.sku}</span>
        <span>${formatCurrency(request.estimatedMonthlyCost)}</span>
      </div>
      <p>${request.justification}</p>
      <div class="muted">Policy: ${request.policyResult || 'n/a'}</div>
      ${budgetLine}
      ${exceptionLine}
      <div class="request-actions">
        <button class="${approveHidden}" data-action="approve" data-id="${request.id}">Approve</button>
        <button class="${rejectHidden}" data-action="reject" data-id="${request.id}">Reject</button>
        <button class="${exceptionHidden}" data-action="exception" data-id="${request.id}">Request Exception</button>
        <button class="${exceptionApproveHidden}" data-action="exception-approve" data-id="${request.id}">Approve Exception</button>
        <button class="${deployHidden}" data-action="deploy" data-id="${request.id}">Deploy</button>
      </div>
    </article>
  `;
}

function renderRequests() {
  el('requests').innerHTML = state.requests.map(requestCard).join('');
  document.querySelectorAll('[data-action]').forEach(button => {
    button.addEventListener('click', onAction);
  });
}

function renderAudit() {
  const items = (state.audit || []).slice(0, 12).map(entry => `
    <div class="audit-item">
      <strong>${entry.action}</strong>
      <div class="muted">${entry.at} · ${entry.actor}</div>
      <div>${entry.subject}</div>
    </div>
  `).join('');
  el('audit').innerHTML = items;
}

async function load() {
  try {
    const me = await api('/api/me');
    state.identity = me.identity;
  } catch {
    state.identity = null;
  }
  const cfg = await api('/api/config');
  state.config = cfg.config;
  state.summary = await api('/api/summary');
  const policy = await api('/api/policy');
  state.policy = policy;
  const requests = await api('/api/requests');
  state.requests = requests.requests;
  const audit = await api('/api/audit');
  state.audit = audit.audit;
  renderSummary();
  renderConfigForm();
  renderIdentity();
  renderRequests();
  renderAudit();
  setActiveView(state.activeView);
}

async function onSubmit(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  const payload = Object.fromEntries(form.entries());
  payload.estimatedMonthlyCost = Number(payload.estimatedMonthlyCost);
  payload.desiredBudgetCap = Number(payload.desiredBudgetCap);
  payload.budgetThresholds = String(payload.budgetThresholdsCsv || '')
    .split(',')
    .map(v => Number(v.trim()))
    .filter(Number.isFinite);
  delete payload.budgetThresholdsCsv;
  await api('/api/requests', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  event.target.title.value = '';
  event.target.justification.value = '';
  event.target.estimatedMonthlyCost.value = '';
  await load();
}

async function onSaveConfig(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  const payload = Object.fromEntries(form.entries());
  payload.defaultBudgetCap = Number(payload.defaultBudgetCap);
  payload.defaultExceptionDurationHours = Number(payload.defaultExceptionDurationHours);
  payload.defaultBudgetThresholds = String(payload.defaultBudgetThresholds || '')
    .split(',')
    .map(v => Number(v.trim()))
    .filter(Number.isFinite);
  await api('/api/config', {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
  await load();
}

async function onAction(event) {
  try {
    const id = event.target.dataset.id;
    const action = event.target.dataset.action;
    if (action === 'approve') {
      await api(`/api/requests/${id}/decision`, {
        method: 'POST',
        body: JSON.stringify({
          decision: 'approved',
          approver: state.config?.procurementApproverEmail || 'procurement@contoso.com',
          comment: 'Approved in APCL demo',
        }),
      });
    }
    if (action === 'reject') {
      await api(`/api/requests/${id}/decision`, {
        method: 'POST',
        body: JSON.stringify({
          decision: 'rejected',
          approver: state.config?.managerApproverEmail || 'manager@contoso.com',
          comment: 'Rejected in APCL demo',
        }),
      });
    }
    if (action === 'deploy') {
      const entitlement = await api(`/api/requests/${id}/entitlement`, {
        method: 'POST',
        body: JSON.stringify({ issuedBy: state.config?.procurementApproverEmail || 'procurement@contoso.com' }),
      });
      await api(`/api/requests/${id}/deploy`, {
        method: 'POST',
        body: JSON.stringify({
          deployedBy: 'pipeline@contoso.com',
          entitlementToken: entitlement.entitlementToken,
        }),
      });
    }
    if (action === 'exception') {
      await api(`/api/requests/${id}/exception`, {
        method: 'POST',
        body: JSON.stringify({
          requestedBy: 'engineer@contoso.com',
          reason: 'Urgent operational need with procurement review pending',
          durationHours: state.config?.defaultExceptionDurationHours || 24,
        }),
      });
    }
    if (action === 'exception-approve') {
      const request = state.requests.find(r => r.id === id);
      const latestException = request && request.exceptions && request.exceptions[request.exceptions.length - 1];
      if (!latestException || latestException.status !== 'requested') {
        throw new Error('No requested exception available to approve');
      }
      await api(`/api/requests/${id}/exception-decision`, {
        method: 'POST',
        body: JSON.stringify({
          exceptionId: latestException.id,
          decision: 'approved',
          approver: state.config?.procurementApproverEmail || 'procurement@contoso.com',
        }),
      });
    }
    await load();
  } catch (err) {
    window.alert(err.message);
  }
}

document.getElementById('request-form').addEventListener('submit', onSubmit);
document.getElementById('config-form').addEventListener('submit', onSaveConfig);
document.getElementById('refresh').addEventListener('click', load);
document.querySelectorAll('.view-btn').forEach(button => {
  button.addEventListener('click', () => setActiveView(button.dataset.view));
});
load().catch(err => {
  document.body.insertAdjacentHTML('afterbegin', `<div style="padding:16px;color:#ff7a7a">Failed to load APCL demo: ${err.message}</div>`);
});
