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

## Production prerequisites outside this repo

The following remain external by design:

1. ERP/ITSM integrations (SAP/ServiceNow).
2. Entra PIM configuration for Azure resource roles.
3. Tenant-scale policy assignment automation.
4. SIEM integration and incident workflows.

## Direct Azure deployment (Azure Container Apps)

### Provision platform

```powershell
./scripts/deploy-platform.ps1 -SubscriptionId <sub-id> -ResourceGroupName rg-apcl-platform-prod -Location australiaeast -ContainerAppName aca-apcl-prod -ContainerAppEnvironmentName cae-apcl-prod -LogAnalyticsWorkspaceName law-apcl-prod -ContainerRegistryName <globally-unique-acr-name> -KeyVaultName <globally-unique-kv-name>
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
