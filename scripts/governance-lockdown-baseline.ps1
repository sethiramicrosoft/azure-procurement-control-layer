param(
  [Parameter(Mandatory = $true)]
  [string]$SubscriptionId,

  [Parameter(Mandatory = $false)]
  [string]$ManagementGroupId = "",

  [Parameter(Mandatory = $false)]
  [string]$PolicyDefinitionId = "",

  [Parameter(Mandatory = $false)]
  [switch]$Apply
)

$ErrorActionPreference = "Stop"

Write-Host "Preparing APCL governance lockdown baseline..." -ForegroundColor Cyan
az account set --subscription $SubscriptionId | Out-Null

$commands = @()

if ($ManagementGroupId -and $PolicyDefinitionId) {
  $commands += "az policy assignment create --name apcl-governance-deny --display-name `"APCL Governance Deny`" --scope /providers/Microsoft.Management/managementGroups/$ManagementGroupId --policy `"$PolicyDefinitionId`""
}

$commands += "az role assignment list --subscription $SubscriptionId --include-inherited --all --query ""[?roleDefinitionName=='Owner' || roleDefinitionName=='Contributor' || roleDefinitionName=='User Access Administrator'].[principalName,roleDefinitionName,scope]"" -o table"
$commands += "az policy exemption list --subscription $SubscriptionId -o table"
$commands += "az role assignment list --subscription $SubscriptionId --all --query ""[?contains(principalName, 'pipeline')].[principalName,roleDefinitionName,scope]"" -o table"

Write-Host ""
Write-Host "Baseline commands:" -ForegroundColor Yellow
$commands | ForEach-Object { Write-Host " - $_" }

if ($Apply) {
  Write-Host ""
  Write-Host "Applying baseline commands..." -ForegroundColor Cyan
  foreach ($cmd in $commands) {
    Write-Host "Running: $cmd" -ForegroundColor DarkGray
    Invoke-Expression $cmd
  }
  Write-Host "Governance lockdown baseline applied." -ForegroundColor Green
} else {
  Write-Host ""
  Write-Host "Dry run complete. Re-run with -Apply to execute commands." -ForegroundColor Green
}
