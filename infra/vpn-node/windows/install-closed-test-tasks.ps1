[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$powerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
$wscript = (Get-Command wscript.exe -ErrorAction Stop).Source
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$hiddenLauncher = (Resolve-Path (Join-Path $PSScriptRoot 'run-hidden-task.vbs')).Path
$apiRunner = (Resolve-Path (Join-Path $PSScriptRoot 'run-local-control-plane.ps1')).Path
$tunnelRunner = (Resolve-Path (Join-Path $PSScriptRoot 'run-amsterdam-reverse-tunnel.ps1')).Path
$bootstrapPath = Join-Path $projectRoot 'var\vpn-nl-01\bootstrap.json'
$bootstrap = Get-Content -LiteralPath $bootstrapPath -Raw | ConvertFrom-Json
if (-not $bootstrap.endpoint.host) {
    throw "Amsterdam endpoint host is missing from $bootstrapPath"
}
$amsterdamRemote = "vpnadmin@$($bootstrap.endpoint.host)"
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$recoveryTrigger = New-ScheduledTaskTrigger `
    -Once `
    -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 1) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable

$definitions = @(
    @{
        Name = 'VPNPlatform-LocalControlPlane'
        Description = 'Closed-test local VPNPlatform API; no public listener.'
        Script = $apiRunner
        ExtraArguments = @()
    },
    @{
        Name = 'VPNPlatform-AmsterdamReverseTunnel'
        Description = 'Closed-test reverse SSH tunnel to Amsterdam over loopback only.'
        Script = $tunnelRunner
        ExtraArguments = @('-Remote', $amsterdamRemote)
    }
)

foreach ($definition in $definitions) {
    $launcherArguments = @(
        $hiddenLauncher,
        $powerShell,
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        $definition.Script
    ) + $definition.ExtraArguments
    $arguments = ($launcherArguments | ForEach-Object {
        if ($_ -match '"') { throw 'Task arguments must not contain double quotes.' }
        "`"$_`""
    }) -join ' '
    $action = New-ScheduledTaskAction -Execute $wscript -Argument $arguments
    Register-ScheduledTask `
        -TaskName $definition.Name `
        -Action $action `
        -Trigger @($logonTrigger, $recoveryTrigger) `
        -Settings $settings `
        -Principal $principal `
        -Description $definition.Description `
        -Force | Out-Null
}

Write-Output 'WINDOWS_TASKS_INSTALLED'
