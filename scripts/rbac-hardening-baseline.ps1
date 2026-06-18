param(
  [Parameter(Mandatory = $true)]
  [string]$SubscriptionId,

  [Parameter(Mandatory = $false)]
  [string]$OutputPath = "./data/rbac-hardening-plan.json",

  [Parameter(Mandatory = $false)]
  [switch]$Apply
)

$ErrorActionPreference = "Stop"

Write-Host "Setting Azure subscription context..." -ForegroundColor Cyan
az account set --subscription $SubscriptionId

$scope = "/subscriptions/$SubscriptionId"
Write-Host "Collecting current role assignments..." -ForegroundColor Cyan
$assignmentsRaw = az role assignment list --scope $scope --all | ConvertFrom-Json

$highPrivilegeRoles = @("Owner", "Contributor", "User Access Administrator")
$highPrivilege = $assignmentsRaw | Where-Object { $_.roleDefinitionName -in $highPrivilegeRoles }

$recommendations = @()
foreach ($item in $highPrivilege) {
  if ($item.principalType -eq "ServicePrincipal") {
    $recommendations += [PSCustomObject]@{
      principalId = $item.principalId
      principalType = $item.principalType
      role = $item.roleDefinitionName
      recommendation = "Review and scope to resource group or custom role."
      action = "investigate"
    }
  } else {
    $recommendations += [PSCustomObject]@{
      principalId = $item.principalId
      principalType = $item.principalType
      role = $item.roleDefinitionName
      recommendation = "Remove standing assignment and move to PIM eligible role."
      action = "remove-or-pim"
    }
  }
}

$plan = [PSCustomObject]@{
  generatedAt = (Get-Date).ToString("o")
  subscriptionId = $SubscriptionId
  scope = $scope
  highPrivilegeAssignments = $highPrivilege.Count
  recommendations = $recommendations
}

$outputDirectory = Split-Path -Parent $OutputPath
if ($outputDirectory -and -not (Test-Path $outputDirectory)) {
  New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
}
$plan | ConvertTo-Json -Depth 8 | Set-Content -Path $OutputPath -Encoding UTF8

Write-Host "RBAC hardening plan saved to $OutputPath" -ForegroundColor Green

if ($Apply) {
  Write-Host "Apply mode enabled. Removing only direct human Contributor assignments." -ForegroundColor Yellow
  foreach ($item in $highPrivilege) {
    if ($item.roleDefinitionName -eq "Contributor" -and $item.principalType -eq "User") {
      Write-Host "Removing Contributor for principal $($item.principalId)" -ForegroundColor Yellow
      az role assignment delete --assignee-object-id $item.principalId --role "Contributor" --scope $scope | Out-Null
    }
  }
  Write-Host "Apply mode complete. Use PIM to reintroduce eligible access where required." -ForegroundColor Green
}
