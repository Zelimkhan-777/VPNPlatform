[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$apiDirectory = Join-Path $projectRoot 'apps\api'
$entryPoint = Join-Path $apiDirectory 'dist\main.js'
$environmentFile = Join-Path $projectRoot '.env'
$logDirectory = Join-Path $projectRoot 'var\vpn-nl-01'
$logFile = Join-Path $logDirectory 'scheduled-control-plane.log'
$node = (Get-Command node.exe -ErrorAction Stop).Source

if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
    throw "Built API entry point does not exist: $entryPoint"
}
if (-not (Test-Path -LiteralPath $environmentFile -PathType Leaf)) {
    throw "Environment file does not exist: $environmentFile"
}
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

Set-Location -LiteralPath $apiDirectory
while ($true) {
    $listener = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue
    if ($listener) {
        Start-Sleep -Seconds 5
        continue
    }

    $startedAt = Get-Date -Format o
    Add-Content -LiteralPath $logFile -Value "$startedAt starting local control-plane API"
    & $node '--env-file-if-exists=../../.env' 'dist/main.js' *>> $logFile
    $exitCode = $LASTEXITCODE
    Add-Content -LiteralPath $logFile -Value "$(Get-Date -Format o) API exited code=$exitCode"
    Start-Sleep -Seconds 5
}
