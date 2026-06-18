param(
  [Parameter(Mandatory = $true)]
  [string]$SubscriptionId,

  [Parameter(Mandatory = $true)]
  [string]$ResourceGroupName,

  [Parameter(Mandatory = $false)]
  [string]$Location = 'australiaeast',

  [Parameter(Mandatory = $true)]
  [string]$VmName,

  [Parameter(Mandatory = $false)]
  [string]$VmSku = 'Standard_D2s_v5',

  [Parameter(Mandatory = $false)]
  [string]$CostCenter = 'ENG001',

  [Parameter(Mandatory = $false)]
  [string]$PoId = 'PO-0001',

  [Parameter(Mandatory = $false)]
  [string]$Owner = 'owner@contoso.com',

  [Parameter(Mandatory = $false)]
  [string]$RequestId = 'REQ-0001',

  [Parameter(Mandatory = $false)]
  [string]$AdminUsername = 'apcladmin'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

$adminPassword = Read-Host -Prompt 'Enter VM admin password' -AsSecureString
$adminPasswordPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($adminPassword)
$adminPasswordPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto($adminPasswordPtr)

try {
  Write-Host "Setting Azure subscription context..." -ForegroundColor Cyan
  az account set --subscription $SubscriptionId

  Write-Host "Ensuring target resource group exists..." -ForegroundColor Cyan
  az group create --name $ResourceGroupName --location $Location --output none

  Write-Host "Deploying approved VM template..." -ForegroundColor Cyan
  az deployment group create `
    --resource-group $ResourceGroupName `
    --template-file "$repoRoot/infra/templates/approved-vm.bicep" `
    --parameters location=$Location vmName=$VmName adminUsername=$AdminUsername adminPassword=$adminPasswordPlain vmSku=$VmSku costCenter=$CostCenter poId=$PoId owner=$Owner requestId=$RequestId `
    --output table

  Write-Host "Deployment completed." -ForegroundColor Green
}
finally {
  if ($adminPasswordPtr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($adminPasswordPtr)
  }
}
