const state = {
  requests: [],
  summary: null,
  policy: null,
};

const el = id => document.getElementById(id);

function formatCurrency(amount, currency = 'AUD') {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency }).format(Number(amount || 0));
}

function badgeForStatus(status) {
  const cls = ['approved', 'deployed'].includes(status) ? 'good' : ['blocked', 'rejected'].includes(status) ? 'bad' : 'warn';
  return `<span class="badge ${cls}">${status}</span>`;
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

function requestCard(request) {
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
      <div class="request-actions">
        <button data-action="approve" data-id="${request.id}">Approve</button>
        <button data-action="reject" data-id="${request.id}">Reject</button>
        <button data-action="deploy" data-id="${request.id}">Deploy</button>
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
  state.summary = await api('/api/summary');
  const policy = await api('/api/policy');
  state.policy = policy;
  const requests = await api('/api/requests');
  state.requests = requests.requests;
  const audit = await api('/api/audit');
  state.audit = audit.audit;
  renderSummary();
  renderRequests();
  renderAudit();
}

async function onSubmit(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  const payload = Object.fromEntries(form.entries());
  payload.estimatedMonthlyCost = Number(payload.estimatedMonthlyCost);
  await api('/api/requests', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  event.target.reset();
  await load();
}

async function onAction(event) {
  const id = event.target.dataset.id;
  const action = event.target.dataset.action;
  if (action === 'approve') {
    await api(`/api/requests/${id}/decision`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approved', approver: 'procurement@contoso.com', comment: 'Approved in APCL demo' }),
    });
  }
  if (action === 'reject') {
    await api(`/api/requests/${id}/decision`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'rejected', approver: 'procurement@contoso.com', comment: 'Rejected in APCL demo' }),
    });
  }
  if (action === 'deploy') {
    await api(`/api/requests/${id}/deploy`, {
      method: 'POST',
      body: JSON.stringify({ deployedBy: 'pipeline@contoso.com' }),
    });
  }
  await load();
}

document.getElementById('request-form').addEventListener('submit', onSubmit);
document.getElementById('refresh').addEventListener('click', load);
load().catch(err => {
  document.body.insertAdjacentHTML('afterbegin', `<div style="padding:16px;color:#ff7a7a">Failed to load APCL demo: ${err.message}</div>`);
});
