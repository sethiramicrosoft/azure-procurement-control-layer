# APCL scale rollout guide

## Purpose

This guide explains how to run APCL at enterprise scale (hundreds of subscriptions), what is included in this repository today, and what each customer should customize.

## What is already included

1. Central APCL control-plane workflow (request, approval, exception, entitlement, deployment gate, reconciliation).
2. Policy baseline template (`infra/policies/policy-pack.bicep`).
3. Assignment policy model in APCL state (cost center -> subscription + resource group prefix + budget cap).
4. Deployment adapter (`local` or `webhook`) for external vending/orchestration systems.
5. RBAC drift reporting endpoint (`/api/rbac/drift-report`).
6. Fleet bootstrap script in this repo for management-group-driven rollout (`scripts/bootstrap-at-management-group.ps1`).

## Scale operating model (best practice)

1. Keep APCL as a single, central control plane per environment.
2. Use management groups for policy inheritance strategy.
3. Use subscription vending for Day-0 onboarding.
4. Use CI/CD for rollout and validation (not manual per-subscription commands).
5. Run scheduled reconciliation and drift checks centrally.

## Customer customization points

### 1) Landing zone and management-group topology

Customize:
- management-group hierarchy and inheritance boundaries
- policy assignment/exemption scopes
- region restrictions by business unit

### 2) Subscription vending integration

Customize:
- pipeline/tooling (CAF accelerator, internal vending platform, Terraform/Bicep pipelines)
- APCL-to-vending payload mapping (environment, archetype, cost center, owner)
- approval checkpoints before subscription handoff

### 3) Policy envelope

Customize:
- required tags
- allowed locations
- allowed SKUs and resource types
- exception policy (duration, approvers, escalation path)

### 4) Approval and auto-approval rules

Customize:
- approver matrix by business function
- standard-pattern auto-approval criteria
- thresholds for finance/procurement review

### 5) Finance integration

Customize:
- reconciliation input source (cost export, FinOps platform, ERP feed)
- orphan spend triage workflow
- chargeback/showback conventions

### 6) Security and operations

Customize:
- RBAC role model and PIM requirements
- SIEM integration and alert routing
- retention/audit export and compliance requirements

## Suggested phased rollout

1. Pilot: one management group, one cost-center family, one approved workload archetype.
2. Expand: onboard additional subscriptions through vending integration.
3. Harden: enforce auto-approval only for standard patterns and keep explicit exception lane.
4. Operate: central scheduled reconciliation + RBAC drift reporting + governance KPI reviews.

## KPI examples for success tracking

- % deployments with valid APCL lineage
- approval cycle time for standard requests
- orphan spend trend
- exception volume and time-to-close
- high-privilege RBAC drift count over time
