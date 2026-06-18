# Azure Procurement Control Layer (APCL)

APCL is an Azure governance accelerator that makes procurement controls enforceable in a consumption model.

It addresses the enterprise gap where cloud spend can be created technically before procurement approval workflows catch up.

## What this accelerator provides

1. **Control model** for approval-to-deployment entitlement.
2. **Azure policy pack** to enforce mandatory procurement metadata and deployment boundaries.
3. **Sample IaC template** for controlled deployment.
4. **Bootstrap scripts** to deploy baseline governance quickly.
5. **Communication assets** to publish externally and socialize internally.

## Core design principles

- **No standing broad access** in governed scopes.
- **Approval is technically binding**, not advisory.
- **Pipeline identity is the deployment path** for standard provisioning.
- **Policy deny > policy alert** for mandatory governance controls.
- **Exceptions are time-bound, approved, and auditable**.

## Repository layout

```text
azure-procurement-control-layer/
  README.md
  .gitignore
  docs/
    architecture.md
    internal-microsoft-plan.md
  infra/
    policies/
      policy-pack.bicep
    templates/
      approved-vm.bicep
  scripts/
    bootstrap.ps1
    deploy-approved-vm.ps1
  assets/
    linkedin-post.md
```

## Prerequisites

- Azure subscription with permission to deploy policy and role assignments.
- Azure CLI (`az`) logged in.
- PowerShell 7+.

## Quick start

1. Create a resource group for governance artifacts:
   ```powershell
   ./scripts/bootstrap.ps1 -SubscriptionId <sub-id> -Location australiaeast -ResourceGroupName rg-apcl-governance
   ```
2. Deploy an approved workload template (example VM):
   ```powershell
   ./scripts/deploy-approved-vm.ps1 -SubscriptionId <sub-id> -ResourceGroupName rg-apcl-approved-workloads -Location australiaeast -VmName vm-apcl-demo
   ```

## What this MVP demonstrates

- Mandatory tags (`CostCenter`, `PO_ID`, `Owner`, `RequestId`) are enforced.
- Region and VM SKU boundaries are enforced by policy.
- Workloads are intended to be deployed through controlled automation using approved metadata.

## Not included in this MVP

- Full Power Platform/ServiceNow request portal implementation.
- SAP/ERP real-time PO integration.
- Complete multi-tenant onboarding automation.

Those are Phase 2 items after baseline control-plane validation.

## Security and governance notes

- Use PIM for Azure resource roles for JIT activation of high privilege access.
- Keep subscription Owner access minimal and tightly controlled.
- Run policy exemptions through documented approval with expiry.

## Contributing

Contributions are welcome for:

- Additional policy packs by regulatory profile.
- Expanded workload templates.
- Integration adapters for ITSM and ERP systems.
