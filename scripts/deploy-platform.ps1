param(
  [Parameter(Mandatory = $true)]
  [string]$SubscriptionId,

  [Parameter(Mandatory = $true)]
  [string]$ResourceGroupName,

  [Parameter(Mandatory = $false)]
  [string]$Location = 'australiaeast',

  [Parameter(Mandatory = $false)]
  [string]$ContainerAppName = 'aca-apcl-prod',

  [Parameter(Mandatory = $false)]
  [string]$ContainerAppEnvironmentName = 'cae-apcl-prod',

  [Parameter(Mandatory = $false)]
  [string]$LogAnalyticsWorkspaceName = 'law-apcl-prod',

  [Parameter(Mandatory = $false)]
  [string]$ContainerRegistryName = 'apclprodacr001',

  [Parameter(Mandatory = $false)]
  [string]$KeyVaultName = 'kv-apcl-prod-001',

  [Parameter(Mandatory = $false)]
  [string]$EntitlementSecretName = 'apcl-entitlement-secret',

  [Parameter(Mandatory = $false)]
  [string]$EntitlementSecretValue,

  [Parameter(Mandatory = $false)]
  [ValidateSet('Bicep', 'ARM')]
  [string]$TemplateType = 'Bicep'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$templateFile = if ($TemplateType -eq 'ARM') { "$repoRoot/infra/platform/main.json" } else { "$repoRoot/infra/platform/main.bicep" }

function New-RandomSecret {
  $bytes = New-Object byte[] 48
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return [Convert]::ToBase64String($bytes)
}

if (-not $EntitlementSecretValue) {
  $EntitlementSecretValue = New-RandomSecret
}

if (-not (Test-Path $templateFile)) {
  throw "Template file not found: $templateFile"
}

Write-Host "Setting Azure subscription context..." -ForegroundColor Cyan
az account set --subscription $SubscriptionId

Write-Host "Ensuring resource group exists..." -ForegroundColor Cyan
az group create --name $ResourceGroupName --location $Location --output none

Write-Host "Deploying APCL platform (ACA + ACR + Key Vault + Log Analytics)..." -ForegroundColor Cyan
$outputsJson = az deployment group create `
  --resource-group $ResourceGroupName `
  --name apcl-platform-$(Get-Date -Format 'yyyyMMddHHmmss') `
  --template-file $templateFile `
  --parameters `
    location=$Location `
    logAnalyticsWorkspaceName=$LogAnalyticsWorkspaceName `
    containerAppEnvironmentName=$ContainerAppEnvironmentName `
    containerAppName=$ContainerAppName `
    containerRegistryName=$ContainerRegistryName `
    keyVaultName=$KeyVaultName `
    entitlementSecretName=$EntitlementSecretName `
    entitlementSecretValue="$EntitlementSecretValue" `
  --query properties.outputs `
  --output json

$outputs = $outputsJson | ConvertFrom-Json

Write-Host "Platform deployment complete." -ForegroundColor Green
Write-Host "Container App: $($outputs.containerAppNameOut.value)"
Write-Host "Container App URL: https://$($outputs.containerAppFqdn.value)"
Write-Host "Container Registry: $($outputs.containerRegistryLoginServer.value)"
Write-Host "Key Vault: $($outputs.keyVaultNameOut.value)"
Write-Host "Secret URI: $($outputs.entitlementSecretUri.value)"
Write-Host "Secret value was generated/set but is intentionally not printed." -ForegroundColor Yellow

Write-Host "`nNext step:" -ForegroundColor Cyan
Write-Host "./scripts/deploy-app-to-aca.ps1 -SubscriptionId $SubscriptionId -ResourceGroupName $ResourceGroupName -ContainerAppName $ContainerAppName -ContainerRegistryName $ContainerRegistryName"
