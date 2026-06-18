param(
  [Parameter(Mandatory = $false)]
  [string]$ApiBaseUrl = "http://localhost:3000",

  [Parameter(Mandatory = $false)]
  [string]$SampleRequestNumber = "APCL-2026-0001"
)

$ErrorActionPreference = "Stop"

$payload = @{
  importedBy = "finops@contoso.com"
  rows       = @(
    @{
      requestNumber = $SampleRequestNumber
      costCenter    = "FIN001"
      poId          = "PO-2026-1001"
      cost          = 250.75
      currency      = "AUD"
      source        = "cost-export"
    },
    @{
      requestNumber = "UNMAPPED-DEMO"
      costCenter    = "ENG001"
      poId          = "PO-UNMAPPED"
      cost          = 97.20
      currency      = "AUD"
      source        = "cost-export"
    }
  )
} | ConvertTo-Json -Depth 5

Write-Host "Importing reconciliation rows..." -ForegroundColor Cyan
$import = Invoke-RestMethod -Method Post -Uri "$ApiBaseUrl/api/reconciliation/import" -ContentType "application/json" -Body $payload
$summary = Invoke-RestMethod -Method Get -Uri "$ApiBaseUrl/api/reconciliation/summary"

Write-Host "Import ID: $($import.importId)" -ForegroundColor Green
$summary | ConvertTo-Json -Depth 8
