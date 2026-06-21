# APCL Reference Architecture

## What APCL is

APCL is a procurement-aware Azure control plane. The repo includes the core runtime, governance policies, deployment templates, and operational scripts needed to request, approve, entitlement-gate, deploy, and reconcile Azure spend.

## Included control-plane modules

The implementation in this repo centers on:

- `server.js` as the HTTP control plane and static UI host
- `lib/state-store.js` for file, SQLite, or managed state backends
- `lib/entitlement.js` for signed entitlement tokens
- `lib/audit.js` for tamper-evident audit chaining
- `infra/policies/policy-pack.bicep` for Azure Policy baseline enforcement
- `infra/templates/approved-vm.bicep` and related templates for governed workload rollout

## Current control flow

1. A requester creates a request in the APCL UI or API.
2. APCL evaluates policy, approval, and exception rules.
3. Approvers can approve, reject, or grant an exception.
4. APCL issues a single-use entitlement token for deployment.
5. Deployment can run locally or via webhook to an external orchestrator.
6. The orchestrator provisions the workload and posts status back to APCL.
7. APCL records audit events and supports reconciliation import plus RBAC drift reporting.

## Runtime and deployment

The production runtime in this repo is designed around:

- Azure Container Apps hosting APCL
- Azure Container Registry for the runtime image
- Azure Key Vault for the entitlement secret
- Azure Files-backed state storage
- Log Analytics for platform logging

The deployment pattern also supports:

- EasyAuth or static token auth
- file, SQLite, or managed state backends
- webhook or local deployment mode
- optional deployment polling and deployer allowlists

## Azure governance layer

APCL applies policy at governed Azure scopes:

- required tags: `CostCenter`, `PO_ID`, `Owner`, `RequestId`
- allowed regions
- allowed VM SKUs
- management-group policy inheritance for the estate
- workload routing into approved subscriptions and resource groups

## Operational extensions

External systems remain out of repo on purpose:

- ERP/ITSM integration for PO validation and commitment sync
- SIEM integration for security monitoring
- tenant onboarding automation for large federated estates
- long-term chargeback/showback reporting pipelines

## Diagram interpretation

The diagram in `assets/apcl-architecture.*` should be read as:

- the requester and approver roles feeding APCL
- APCL gating deployment with entitlement and policy
- APCL handing off to an external orchestrator for Azure provisioning
- APCL reconciling spend and drift after deployment

