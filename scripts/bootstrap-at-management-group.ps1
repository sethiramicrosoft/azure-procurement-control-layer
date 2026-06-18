param(
  [Parameter(Mandatory = $true)]
  [string]$ManagementGroupId,

  [Parameter(Mandatory = $false)]
  [string]$Location = 'australiaeast',

  [Parameter(Mandatory = $false)]
  [string]$ResourceGroupName = 'rg-apcl-governance'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

Write-Host "Resolving subscriptions under management group '$ManagementGroupId'..." -ForegroundColor Cyan
$subscriptions = az account management-group subscription show-sub-under-mg --name $ManagementGroupId --query "[].name" -o tsv

if (-not $subscriptions) {
  throw "No subscriptions found under management group '$ManagementGroupId'."
}

$subscriptionList = @($subscriptions -split "`r?`n" | Where-Object { $_ -and $_.Trim().Length -gt 0 })
Write-Host "Found $($subscriptionList.Count) subscriptions." -ForegroundColor Green

$failed = @()

foreach ($subId in $subscriptionList) {
  Write-Host "`nApplying APCL baseline to subscription: $subId" -ForegroundColor Cyan
  try {
    az account set --subscription $subId

    az group create --name $ResourceGroupName --location $Location --output none

    az deployment sub create `
      --name apcl-policy-pack-$($subId)-$(Get-Date -Format 'yyyyMMddHHmmss') `
      --location $Location `
      --template-file "$repoRoot/infra/policies/policy-pack.bicep" `
      --parameters location=$Location `
      --output none

    Write-Host "Success: $subId" -ForegroundColor Green
  }
  catch {
    Write-Host "Failed: $subId" -ForegroundColor Red
    $failed += $subId
  }
}

if ($failed.Count -gt 0) {
  Write-Host "`nCompleted with failures. Failed subscriptions:" -ForegroundColor Yellow
  $failed | ForEach-Object { Write-Host "- $_" }
  exit 1
}

Write-Host "`nAPCL baseline applied to all subscriptions in management group '$ManagementGroupId'." -ForegroundColor Green
