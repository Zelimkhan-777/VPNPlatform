[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$requiredVersion = [Version]'1.24.0'
$module = Get-Module -ListAvailable -Name PSScriptAnalyzer |
    Where-Object { $_.Version -eq $requiredVersion } |
    Select-Object -First 1
if (-not $module) {
    throw "PSScriptAnalyzer $requiredVersion is required."
}
Import-Module -Name $module.Path -Force

$scripts = @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1' -File -Recurse |
    Sort-Object FullName)
if ($scripts.Count -eq 0) {
    throw 'No infrastructure PowerShell scripts were found.'
}

$diagnostics = @($scripts | ForEach-Object {
    Invoke-ScriptAnalyzer -Path $_.FullName -Severity Error, Warning
})
if ($diagnostics.Count -gt 0) {
    $rendered = $diagnostics |
        Format-Table RuleName, Severity, ScriptName, Line, Message -AutoSize |
        Out-String
    throw "PSScriptAnalyzer found $($diagnostics.Count) diagnostic(s):`n$rendered"
}

Write-Output "PSSCRIPTANALYZER_OK version=$requiredVersion scripts=$($scripts.Count)"
