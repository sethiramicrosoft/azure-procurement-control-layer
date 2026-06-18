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
