# APCL Operations Guide

## Control plane capabilities implemented in-repo

1. Request intake with policy evaluation.
2. Approval and rejection workflow.
3. Exception workflow (request, approve/reject, expiry).
4. Entitlement token issuance and single-use deployment enforcement.
5. Tamper-evident audit chain for all control-plane decisions.
6. Reconciliation import and orphan spend detection.
7. Control-plane status endpoint for operational monitoring.

## API endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/health` | GET | Service heartbeat |
| `/api/readiness` | GET | Deployment readiness posture (503 when production checks fail) |
| `/api/summary` | GET | Dashboard summary |
| `/api/config` | GET/PUT | Control-plane defaults (emails, budgets, thresholds) |
| `/api/control-plane/status` | GET | Control-plane configuration/status |
| `/api/requests` | GET/POST | List and create requests |
| `/api/requests/{id}/decision` | POST | Approve/reject request |
| `/api/requests/{id}/assign` | POST | Create/reuse assignment (subscription/RG + budget cap) |
| `/api/requests/{id}/exception` | POST | Request exception |
| `/api/requests/{id}/exception-decision` | POST | Approve/reject exception |
| `/api/requests/{id}/entitlement` | POST | Issue deployment entitlement token |
| `/api/requests/{id}/deploy` | POST | Deploy with entitlement token |
| `/api/deployments/{id}/status` | POST | Update async deployment execution status |
| `/api/governance/posture` | GET | Governance control posture checks |
| `/api/operations/metrics` | GET | Operational metrics (security/platform) |
| `/api/reconciliation/import` | POST | Import usage rows for reconciliation |
| `/api/reconciliation/summary` | GET | Reconciliation status |
| `/api/reconciliation/run` | POST | Recompute budget and chargeback snapshots |
| `/api/chargeback/summary` | GET | Cost by cost center and PO |
| `/api/rbac/drift-report` | POST | Human high-privilege RBAC drift report |
| `/api/audit` | GET | Audit trail with hash chain |

## Reconciliation import payload

```json
{
  "importedBy": "finops@contoso.com",
  "rows": [
    {
      "requestNumber": "APCL-2026-0001",
      "costCenter": "FIN001",
      "poId": "PO-2026-1001",
      "cost": 320.55,
      "currency": "AUD",
      "source": "cost-export"
    }
  ]
}
```

Rows that do not match an APCL request are marked as orphan spend and returned by `/api/reconciliation/summary`.

## RBAC hardening baseline

Run:

```powershell
./scripts/rbac-hardening-baseline.ps1 -SubscriptionId <sub-id>
```

This generates a remediation plan for high-privilege assignments. Use `-Apply` only after review.

For broader subscription/management-group governance lockdown bootstrap:

```powershell
./scripts/governance-lockdown-baseline.ps1 -SubscriptionId <sub-id>
```

Incident runbook: `docs/incident-runbook.md`.

## Production prerequisites outside this repo

The following remain external by design:

1. ERP/ITSM integrations (SAP/ServiceNow).
2. Entra PIM configuration for Azure resource roles.
3. Tenant-scale policy assignment automation.
4. SIEM integration and incident workflows.

## Authentication and role model

APCL supports these runtime auth modes:

1. `APCL_AUTH_MODE=none` for local demo only.
2. `APCL_AUTH_MODE=easyauth` for Azure-hosted identity claims (`x-ms-client-principal`).
3. `APCL_AUTH_MODE=static` for controlled non-production bearer token testing (`APCL_STATIC_TOKENS_JSON`).

In production:

- `APCL_AUTH_MODE=none` is blocked.
- default entitlement secret is blocked.
- webhook callback can be secured with `APCL_DEPLOYMENT_STATUS_TOKEN` (`x-apcl-status-token` header).

Authority checks:

- Request approval requires configured procurement approver identity (or platform role).
- Exception decision / entitlement issuance / assignment require configured procurement approver identity (or platform role).
- Requester exception submission is limited to the originating requester identity (unless procurement/platform role).
- Optional deploy governance mode limits `/deploy` to an explicit allowlist (`APCL_ENFORCE_DEPLOYER_ALLOWLIST=true` + `APCL_ALLOWED_DEPLOYER_IDENTITIES`).
- Approver authority can be enforced by claim groups using `APCL_APPROVER_GROUPS_JSON`.

## State backend and audit export

Runtime options:

1. `APCL_STATE_BACKEND=file` (default demo mode).
2. `APCL_STATE_BACKEND=sqlite` (recommended for hardened runtime in this repository).
3. `APCL_STATE_BACKEND=managed` (recommended production integration mode via adapter).

Optional settings:

- `APCL_SQLITE_DB_PATH=<path-to-apcl.db>`
- `APCL_MANAGED_STATE_ADAPTER_PATH=<absolute path to adapter module>`
- `APCL_AUDIT_EXPORT_PATH=<path-to-audit-export.jsonl>`
- `APCL_AUDIT_EXPORT_SECRET=<hmac-signing-secret>`
- `APCL_DEPLOYMENT_WEBHOOK_HMAC_SECRET=<shared-secret>`
- `APCL_DEPLOYMENT_STATUS_TOKEN=<shared-callback-token>`
- `APCL_DEPLOYMENT_WEBHOOK_TIMEOUT_MS=<milliseconds>`
- `APCL_DEPLOYMENT_WEBHOOK_RETRY_COUNT=<attempts-after-first>`
- `APCL_DEPLOYMENT_WEBHOOK_RETRY_DELAY_MS=<milliseconds>`
- `APCL_DEPLOYMENT_IDEMPOTENCY_HEADER=<header-name>`
- `APCL_EASYAUTH_ALLOWED_APP_IDS=<comma-separated app ids/audiences>`
- `APCL_EASYAUTH_ALLOWED_TENANT_IDS=<comma-separated tenant ids>`
- `APCL_EASYAUTH_GROUP_ROLE_MAP_JSON=<json group-to-role map>`
- `APCL_APPROVER_GROUPS_JSON=<json approver-group map>`
- `APCL_ENFORCE_DEPLOYER_ALLOWLIST=true|false`
- `APCL_ALLOWED_DEPLOYER_IDENTITIES=<comma-separated identities>`
- `APCL_DEPLOYMENT_POLL_ENABLED=true|false`
- `APCL_DEPLOYMENT_POLL_URL_TEMPLATE=<url containing {runId}>`
- `APCL_DEPLOYMENT_POLL_INTERVAL_MS=<milliseconds>`
- `APCL_DEPLOYMENT_POLL_MAX_ATTEMPTS=<attempts>`
- `APCL_DEPLOYMENT_POLL_BEARER_TOKEN=<bearer token for poll endpoint>`

When SQLite backend is enabled, state writes use version-checked updates to reduce silent overwrite risk under concurrent requests.

Production startup guardrails also require:

1. `APCL_EASYAUTH_ALLOWED_TENANT_IDS` configured
2. state backend as either:
   - `APCL_STATE_BACKEND=managed` with `APCL_MANAGED_STATE_ADAPTER_PATH`, or
   - `APCL_STATE_BACKEND=sqlite` with persistent non-`/tmp` `APCL_SQLITE_DB_PATH`
3. non-`/tmp` audit path
4. `APCL_AUDIT_EXPORT_SECRET` configured

Webhook signing:

1. APCL includes `x-apcl-timestamp` and `x-apcl-signature` when `APCL_DEPLOYMENT_WEBHOOK_HMAC_SECRET` is set.
2. Signature formula: `HMAC_SHA256(secret, "<timestamp>.<raw-json-body>")`.
3. Orchestrator should verify timestamp freshness and signature before accepting trigger.
4. Callback requests with invalid `x-apcl-status-token` are rejected with `401`.
5. Deployment status updates are transition-validated (terminal `succeeded/failed` runs cannot transition back to `running/queued`).
6. Webhook trigger path retries transient failures (429/5xx/network) using the configured timeout/retry controls.
7. Deployment requests can be safely retried by caller with idempotency key header; APCL replays the recorded execution response.
8. When poll mode is enabled, APCL queries the external run endpoint until terminal state or poll window exhaustion.

## Automated validation

```powershell
npm test
```

CI workflow: `.github/workflows/ci.yml` (push + PR).

Security workflow: `.github/workflows/security.yml` (CodeQL + npm audit gate).

## Direct Azure deployment (Azure Container Apps)

### Provision platform

```powershell
./scripts/deploy-platform.ps1 -SubscriptionId <sub-id> -ResourceGroupName rg-apcl-platform-prod -Location australiaeast -ContainerAppName aca-apcl-prod -ContainerAppEnvironmentName cae-apcl-prod -LogAnalyticsWorkspaceName law-apcl-prod -ContainerRegistryName <globally-unique-acr-name> -KeyVaultName <globally-unique-kv-name> -StateStorageAccountName <globally-unique-storage-name> -StateFileShareName apclstate -EasyAuthTenantId <tenant-id> -EasyAuthClientId <app-client-id> -EasyAuthClientSecret "<app-client-secret>"
```

Use ARM output instead of Bicep:

```powershell
./scripts/deploy-platform.ps1 -SubscriptionId <sub-id> -ResourceGroupName rg-apcl-platform-prod -Location australiaeast -ContainerAppName aca-apcl-prod -ContainerAppEnvironmentName cae-apcl-prod -LogAnalyticsWorkspaceName law-apcl-prod -ContainerRegistryName <globally-unique-acr-name> -KeyVaultName <globally-unique-kv-name> -TemplateType ARM
```

Regenerate ARM output from Bicep whenever infrastructure changes:

```powershell
./scripts/build-arm-from-bicep.ps1
```

### Deploy application image

```powershell
./scripts/deploy-app-to-aca.ps1 -SubscriptionId <sub-id> -ResourceGroupName rg-apcl-platform-prod -ContainerAppName aca-apcl-prod -ContainerRegistryName <globally-unique-acr-name>
```

Container Apps auth boundary is now codified in deployment automation:

1. `az containerapp auth update` enables auth and returns `401` for unauthenticated requests.
2. `az containerapp auth microsoft update` configures Entra provider settings (tenant, client, issuer, audience).
3. Script updates APCL runtime allowlist env vars to match provider settings.
4. Script provisions Azure Files-backed state volume and mounts it at `/var/lib/apcl` in Container Apps.

### Post-deploy validation

1. Open `https://<apcl-fqdn>/api/health`.
2. Open APCL UI root URL and create a request.
3. Confirm entitlement issuance and deploy flow works.
4. Run reconciliation import and verify summary endpoint.

### Enterprise customization reminders

- move `APCL_DEPLOYMENT_MODE` to `webhook` for production orchestration integration
- align ingress exposure with security policy
- configure monitoring, alerting, and log retention
- move from file-based state to managed datastore for production scale
