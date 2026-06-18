# APCL Reference Architecture (MVP)

## Problem

Traditional procurement is pre-approval and PO-first. Azure is consume-first. This causes control, visibility, and chargeback gaps when technical users can create spend before procurement governance is applied.

## Architecture overview

APCL introduces a procurement-aware control layer on top of Azure using three control loops:

1. **Approval loop**: request context and decision logic.
2. **Enforcement loop**: Azure RBAC + Policy at governed scopes.
3. **Finance loop**: tagging discipline, budget mapping, and reconciliation.

## Logical components

- **Request/Approval service** (external to MVP): captures business need, cost center, PO context, and approval result.
- **Governance policy pack** (included): enforces mandatory metadata and allowed deployment boundaries.
- **Controlled deployment templates** (included): standardizes workload creation.
- **Reporting/reconciliation** (external to MVP): maps approved intent to actual cost.

## Control flow

1. Request is approved by defined authorities.
2. Deployment proceeds only through controlled automation identities.
3. Policy validates metadata and boundary constraints.
4. Costs are attributed using mandatory tags and reconciled downstream.

## Operating model assumptions

- Platform team owns policy lifecycle and enforcement.
- Procurement/Finance owns approval and exception criteria.
- Engineering teams deploy within approved patterns.

## MVP control boundaries

This MVP enforces:

- Mandatory tags: `CostCenter`, `PO_ID`, `Owner`, `RequestId`.
- Allowed locations.
- Allowed VM SKUs.

## Phase 2 extensions

- Automated entitlement tokens from approvals.
- Time-bound exception workflow with expiry.
- Multi-tenant delegated governance onboarding.
- ERP integration for PO validation.
