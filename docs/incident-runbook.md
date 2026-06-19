# APCL Incident Runbook

## Severity model

1. **SEV1**: Deployment control bypass, unauthorized approval/deploy, or prolonged outage.
2. **SEV2**: Reconciliation drift, webhook/polling failures, degraded control-plane APIs.
3. **SEV3**: Non-critical UI/API defects with workaround.

## Primary SLO targets

1. API availability (`/api/health`): **99.9% monthly**
2. Deployment execution response (submit -> queued/succeeded/failed): **p95 < 5s** for local control path
3. Webhook callback reconciliation lag: **< 5 minutes**

## Detection sources

1. `GET /api/governance/posture` non-compliant check results.
2. `GET /api/operations/metrics` spikes in failed or queued deployments.
3. CI/security workflow failures in GitHub Actions.
4. Azure Monitor alerts from Container Apps/log analytics.

## Triage checklist

1. Confirm auth/runtime posture:
   - `APCL_AUTH_MODE`
   - `APCL_DEPLOYMENT_MODE`
   - status token + webhook signing configured
   - deployer allowlist enabled
2. Review latest audit entries (`GET /api/audit`) for:
   - `request-approved` / `request-rejected`
   - `deployment-queued` / `deployment-failed`
   - `deployment-status-*`
3. Validate deployment pipeline/orchestrator endpoint health.
4. Validate poll endpoint health if poll mode is enabled.

## Containment actions

1. Disable new deployment execution by temporarily removing deployer identities from allowlist.
2. Rotate callback token and webhook HMAC secret.
3. Restrict access via platform role only while incident is active.
4. Pause exception approvals if governance controls are degraded.

## Recovery actions

1. Restore orchestrator connectivity and callback pipeline.
2. Replay failed deployment requests using idempotency keys.
3. Re-run reconciliation import for affected billing windows.
4. Validate posture endpoint returns compliant status.

## Post-incident tasks

1. Export incident timeline from audit stream.
2. Add/adjust negative test cases in `tests/apcl-phase3.test.js`.
3. Update governance baseline script and IaC defaults if needed.
4. Record corrective actions and owners.
