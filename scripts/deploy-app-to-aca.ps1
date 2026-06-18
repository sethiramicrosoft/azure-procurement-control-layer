param(
  [Parameter(Mandatory = $true)]
  [string]$SubscriptionId,

  [Parameter(Mandatory = $true)]
  [string]$ResourceGroupName,

  [Parameter(Mandatory = $true)]
  [string]$ContainerAppName,

  [Parameter(Mandatory = $true)]
  [string]$ContainerRegistryName,

  [Parameter(Mandatory = $false)]
  [string]$ImageName = 'apcl:latest'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$fullImage = "$ContainerRegistryName.azurecr.io/$ImageName"

Write-Host "Setting Azure subscription context..." -ForegroundColor Cyan
az account set --subscription $SubscriptionId

Write-Host "Building and pushing APCL image to ACR..." -ForegroundColor Cyan
az acr build --registry $ContainerRegistryName --image $ImageName $repoRoot

Write-Host "Configuring Container App to use managed identity for ACR pull..." -ForegroundColor Cyan
az containerapp registry set `
  --name $ContainerAppName `
  --resource-group $ResourceGroupName `
  --server "$ContainerRegistryName.azurecr.io" `
  --identity system `
  --output none

Write-Host "Updating Container App image..." -ForegroundColor Cyan
az containerapp update `
  --name $ContainerAppName `
  --resource-group $ResourceGroupName `
  --image $fullImage `
  --output none

$fqdn = az containerapp show --name $ContainerAppName --resource-group $ResourceGroupName --query "properties.configuration.ingress.fqdn" -o tsv

Write-Host "Deployment complete." -ForegroundColor Green
Write-Host "APCL URL: https://$fqdn"
Write-Host "Health check: https://$fqdn/api/health"
