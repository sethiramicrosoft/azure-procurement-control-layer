param(
  [Parameter(Mandatory = $true)]
  [string]$SubscriptionId,

  [Parameter(Mandatory = $false)]
  [string]$ApiBaseUrl = "http://localhost:3000"
)

$ErrorActionPreference = "Stop"

Write-Host "Setting Azure subscription context..." -ForegroundColor Cyan
az account set --subscription $SubscriptionId

$scope = "/subscriptions/$SubscriptionId"
Write-Host "Collecting role assignments from $scope..." -ForegroundColor Cyan
$assignments = az role assignment list --scope $scope --all | ConvertFrom-Json

$payload = @{
  generatedBy = "security@contoso.com"
  assignments = $assignments
} | ConvertTo-Json -Depth 20

Write-Host "Submitting RBAC drift report request..." -ForegroundColor Cyan
$report = Invoke-RestMethod -Method Post -Uri "$ApiBaseUrl/api/rbac/drift-report" -ContentType "application/json" -Body $payload
$report | ConvertTo-Json -Depth 10
