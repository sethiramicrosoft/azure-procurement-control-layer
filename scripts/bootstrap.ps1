param(
  [Parameter(Mandatory = $true)]
  [string]$SubscriptionId,

  [Parameter(Mandatory = $false)]
  [string]$Location = 'australiaeast',

  [Parameter(Mandatory = $false)]
  [string]$ResourceGroupName = 'rg-apcl-governance'
)

$ErrorActionPreference = 'Stop'

Write-Host "Setting Azure subscription context..." -ForegroundColor Cyan
az account set --subscription $SubscriptionId

Write-Host "Ensuring governance resource group exists..." -ForegroundColor Cyan
az group create --name $ResourceGroupName --location $Location --output none

Write-Host "Deploying APCL baseline policy pack..." -ForegroundColor Cyan
az deployment sub create `
  --name apcl-policy-pack-$(Get-Date -Format 'yyyyMMddHHmmss') `
  --location $Location `
  --template-file ./infra/policies/policy-pack.bicep `
  --parameters location=$Location `
  --output table

Write-Host "APCL bootstrap complete." -ForegroundColor Green
