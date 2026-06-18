# Azure Procurement Control Layer (APCL)

APCL is a procurement-aware Azure governance control plane starter.

It helps enterprises enforce this chain for Azure consumption:

1. request
2. approval
3. entitlement
4. deployment
5. policy compliance
6. cost reconciliation
7. finance visibility

This repository includes a working local control-plane app, Azure governance templates, and operational scripts you can adapt to your internal environment.

## Why APCL exists

Most procurement operating models are PO-first and pre-approved.
Azure is consumption-first and engineer-triggered.

That mismatch creates common enterprise risks:

- spend created before procurement approval
- weak attribution (cost center / PO / owner)
- delayed visibility (invoice-time surprises)
- fragmented controls across subscriptions/tenants

APCL addresses this by making deployment permission conditional on approved intent.

## What APCL does today

### Implemented in this repo

- Request intake API + UI with procurement metadata.
- Approval/rejection workflow.
- Exception workflow (request, approve/reject, expiry).
- Entitlement token issuance for approved/exception-approved requests.
- Deployment API enforcement (valid APCL token required).
- Single-use entitlement consumption.
- Tamper-evident audit hash chain (`prevHash` + `hash`).
- Reconciliation import endpoint with orphan spend detection.
- Azure Policy baseline (required tags, allowed regions, allowed VM SKUs).
- Sample approved VM Bicep template.
- RBAC hardening baseline script.

### External integrations not included in-repo

- Live SAP/ERP APIs.
- Live ServiceNow/ITSM APIs.
- Entra PIM configuration automation.
- SIEM ingestion pipelines.
- Tenant-scale onboarding automation.

Those are intentionally outside this repo and should be wired to your internal systems.

## Reference flow

1. Engineer creates request with business and procurement metadata.
2. Manager/procurement decides approve/reject.
3. If approved (or valid approved exception exists), APCL issues entitlement token.
4. Deployment endpoint accepts only valid, unexpired, unused token.
5. Azure Policy denies non-compliant resource creation.
6. Cost rows are imported and matched to request lineage.
7. Orphan spend is surfaced for FinOps/procurement follow-up.

## Prerequisites

### 1) Local runtime (for APCL control-plane app)

- Node.js 18+
- PowerShell 7+
- Optional Docker (for container run)

### 2) Azure governance deployment

- Azure subscription access for:
  - policy definition/assignment deployment
  - resource group creation
  - role assignment inspection
- Azure CLI (`az`) authenticated
- Bicep support in Azure CLI (`az bicep`)

### 3) Org readiness (for enterprise rollout)

- Cost center master data
- PO/commitment model
- Approval authority matrix (manager/procurement/finance)
- RBAC ownership model (platform/security/procurement)

## Quick start

### A. Run local APCL app

```powershell
npm start
```

Open:

```text
http://localhost:3000
```

### B. Deploy Azure policy baseline

```powershell
./scripts/bootstrap.ps1 -SubscriptionId <sub-id> -Location australiaeast -ResourceGroupName rg-apcl-governance
```

### C. Deploy approved workload template (example VM)

```powershell
./scripts/deploy-approved-vm.ps1 -SubscriptionId <sub-id> -ResourceGroupName rg-apcl-approved-workloads -Location australiaeast -VmName vm-apcl-demo
```

### D. Generate RBAC hardening plan

```powershell
./scripts/rbac-hardening-baseline.ps1 -SubscriptionId <sub-id>
```

## Internal system integration guide

APCL is designed to connect to your internal systems through adapter APIs.

### Procurement / ITSM integration (recommended)

Use APCL as the control-plane API behind your existing front-door workflow.

- Source systems: ServiceNow, SAP, Dynamics, custom procurement portal.
- Integration pattern:
  1. system creates APCL request
  2. external approval decision posts to APCL decision endpoint
  3. external orchestrator calls entitlement + deploy
  4. reconciliation summaries are fed back to finance tooling

### Identity and access integration

- Keep broad Azure RBAC roles minimal.
- Use PIM for eligible elevation.
- Restrict deployment path to approved automation identities.
- Set strong secret for entitlement signing (`APCL_ENTITLEMENT_SECRET`).

### Finance / FinOps integration

- Import cost rows via reconciliation endpoint.
- Match by APCL request number and procurement metadata.
- Route orphan spend to remediation queue.

### Security / SOC integration

- Forward audit events to SIEM.
- Alert on:
  - denied deployments
  - repeated invalid entitlement attempts
  - exception approvals near expiry
  - orphan spend spikes

## API surface (high-level)

- `GET /api/health`
- `GET /api/summary`
- `GET /api/control-plane/status`
- `GET|POST /api/requests`
- `POST /api/requests/{id}/decision`
- `POST /api/requests/{id}/exception`
- `POST /api/requests/{id}/exception-decision`
- `POST /api/requests/{id}/entitlement`
- `POST /api/requests/{id}/deploy`
- `POST /api/reconciliation/import`
- `GET /api/reconciliation/summary`
- `GET /api/audit`

See `docs/operations.md` for payload examples and operations details.

## Deployment options

### Local process

```powershell
npm start
```

### Container

```powershell
docker build -t apcl:latest .
docker run -p 3000:3000 -e APCL_ENTITLEMENT_SECRET="<strong-secret>" apcl:latest
```

### Enterprise deployment target patterns

- App Service / Container Apps for control plane
- Azure SQL/Cosmos (replace local JSON state)
- Key Vault for signing secrets
- CI/CD pipeline with environment isolation

## Production hardening checklist

- [ ] Replace file-based state with managed datastore.
- [ ] Configure Key Vault secret retrieval.
- [ ] Enable authentication and API authorization boundaries.
- [ ] Integrate PIM and privileged access governance.
- [ ] Wire SIEM and incident workflows.
- [ ] Integrate ERP/ITSM connectors.
- [ ] Define retention and audit export policy.
- [ ] Add backup/restore and DR runbooks.

## Current maturity statement

This repo is a strong control-plane starter and pilot-ready accelerator.
It is not a complete enterprise product until your internal identity, ITSM/ERP, and SOC integrations are wired.

## Contributing

Contributions are welcome for:

- policy packs by regulatory profile
- enterprise integration adapters
- hardened persistence backends
- multi-tenant onboarding automation
