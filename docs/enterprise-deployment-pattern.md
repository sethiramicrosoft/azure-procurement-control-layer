# APCL enterprise deployment pattern (copy-ready template)

## Objective

Deploy APCL in a way that scales across large Azure estates while preserving procurement governance and engineering velocity.

## Reference architecture

1. Central APCL service (API + UI) per environment.
2. Management-group-driven policy inheritance across subscription fleet.
3. APCL-to-vending integration via webhook adapter.
4. Central reconciliation pipeline + drift reporting pipeline.

## Step 1: Deploy APCL service

Minimum production baseline:
- run APCL in App Service or Container Apps
- set `APCL_ENTITLEMENT_SECRET` to a strong secret from Key Vault
- restrict API access to approved identities/networks

Environment variables:
- `APCL_ENTITLEMENT_SECRET=<strong-secret>`
- `APCL_ENTITLEMENT_TTL_MINUTES=60`
- `APCL_DEPLOYMENT_MODE=webhook`
- `APCL_DEPLOYMENT_WEBHOOK_URL=<your-vending-orchestration-endpoint>`
- `APCL_AUTH_MODE=easyauth`
- `APCL_STATE_BACKEND=sqlite`
- `APCL_SQLITE_DB_PATH=/app/data/apcl.db`
- `APCL_AUDIT_EXPORT_PATH=/app/data/audit-export.jsonl`

## Step 2: Roll out governance baseline to subscription fleet

Use management-group fleet rollout:

```powershell
./scripts/bootstrap-at-management-group.ps1 -ManagementGroupId <mg-id> -Location australiaeast -ResourceGroupName rg-apcl-governance
```

## Step 3: Configure APCL control defaults and assignment policies

Control defaults (API/UI):
- approver emails
- default budget cap and thresholds
- default exception duration

Assignment policy model:
- cost center -> subscription
- cost center -> resource-group prefix
- cost center -> budget cap

## Step 4: Integrate vending/orchestration

APCL provides:
- approved request context
- assignment context
- entitlement-gated deployment handoff

Your orchestrator provides:
- landing zone/subscription selection
- workload provisioning implementation
- deployment run status feedback (`POST /api/deployments/{executionId}/status`)

## Step 5: Operate centrally

Run on schedule:
- reconciliation imports (`/api/reconciliation/import`)
- RBAC drift checks (`/api/rbac/drift-report`)

Track:
- orphan spend
- policy/approval compliance
- exception lifecycle metrics
- privileged role drift trends

## Customization matrix

### Current setup variations

- **If you already have ALZ + vending**: keep APCL as procurement/entitlement front door and connect webhook to existing pipeline.
- **If you have ALZ but no vending**: start with APCL + management-group rollout + controlled deploy templates, then phase in vending.
- **If you have neither**: pilot APCL on one management group and establish subscription onboarding pattern before broad rollout.

### Future-state extensions

- managed datastore for APCL state
- full identity/PIM integration
- SIEM event export and SOC runbooks
- ERP/ITSM connector hardening
- multi-region APCL runtime and DR posture
