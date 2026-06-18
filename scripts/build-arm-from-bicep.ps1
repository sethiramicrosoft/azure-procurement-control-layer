param(
  [Parameter(Mandatory = $false)]
  [string]$InputBicep = 'infra/platform/main.bicep',

  [Parameter(Mandatory = $false)]
  [string]$OutputArm = 'infra/platform/main.json'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$inputPath = Join-Path $repoRoot $InputBicep
$outputPath = Join-Path $repoRoot $OutputArm

Write-Host "Building ARM template from Bicep..." -ForegroundColor Cyan
az bicep build --file $inputPath --outfile $outputPath

Write-Host "ARM template generated at: $outputPath" -ForegroundColor Green
