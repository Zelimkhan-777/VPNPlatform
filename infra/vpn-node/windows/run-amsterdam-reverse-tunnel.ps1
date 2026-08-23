[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Remote,
    [string]$IdentityFile = (Join-Path $env:USERPROFILE '.ssh\id_ed25519')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$logDirectory = Join-Path $projectRoot 'var\vpn-nl-01'
$logFile = Join-Path $logDirectory 'scheduled-reverse-ssh.log'
$stdoutFile = Join-Path $logDirectory 'scheduled-reverse-ssh.stdout.log'
$stderrFile = Join-Path $logDirectory 'scheduled-reverse-ssh.stderr.log'
$processStateFile = Join-Path $logDirectory 'scheduled-reverse-ssh-process.json'
$ssh = (Get-Command ssh.exe -ErrorAction Stop).Source
$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)

if (-not (Test-Path -LiteralPath $IdentityFile -PathType Leaf)) {
    throw "SSH identity does not exist: $IdentityFile"
}
if ($Remote -notmatch '^[A-Za-z0-9_.-]+@[A-Za-z0-9.:-]+$') {
    throw 'Remote must use the form user@host without shell metacharacters.'
}
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

$sshArguments = @(
    '-N',
    '-T',
    '-i', "`"$IdentityFile`"",
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=20',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'TCPKeepAlive=yes',
    '-R', '127.0.0.1:13001:127.0.0.1:3001',
    $Remote
)
$sshArgumentLine = $sshArguments -join ' '

function Write-RunnerLog {
    param([Parameter(Mandatory = $true)][string]$Message)

    [System.IO.File]::AppendAllText(
        $logFile,
        "$(Get-Date -Format o) $Message$([Environment]::NewLine)",
        $utf8WithoutBom
    )
}

function Get-TrackedSshProcess {
    if (-not (Test-Path -LiteralPath $processStateFile -PathType Leaf)) {
        return $null
    }

    try {
        $state = Get-Content -LiteralPath $processStateFile -Raw | ConvertFrom-Json
        $process = Get-Process -Id ([int]$state.processId) -ErrorAction Stop
        $startedAt = $process.StartTime.ToUniversalTime().ToString('o')
        if ($process.ProcessName -ne 'ssh' -or $startedAt -ne [string]$state.startedAtUtc) {
            throw 'Tracked process identity does not match.'
        }
        return $process
    }
    catch {
        Remove-Item -LiteralPath $processStateFile -Force -ErrorAction SilentlyContinue
        return $null
    }
}

function Save-TrackedSshProcess {
    param([Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process)

    $temporary = "$processStateFile.tmp"
    @{
        processId = $Process.Id
        startedAtUtc = $Process.StartTime.ToUniversalTime().ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $processStateFile -Force
}

function Append-ProcessOutput {
    foreach ($path in @($stdoutFile, $stderrFile)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            continue
        }
        $content = Get-Content -LiteralPath $path -Raw -ErrorAction SilentlyContinue
        if ($content) {
            [System.IO.File]::AppendAllText($logFile, $content, $utf8WithoutBom)
            if (-not $content.EndsWith([Environment]::NewLine)) {
                [System.IO.File]::AppendAllText($logFile, [Environment]::NewLine, $utf8WithoutBom)
            }
        }
    }
}

while ($true) {
    $process = Get-TrackedSshProcess
    if ($process) {
        Write-RunnerLog "adopting reverse SSH pid=$($process.Id)"
    }
    else {
        $listener = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue
        if (-not $listener) {
            Start-Sleep -Seconds 5
            continue
        }

        try {
            Write-RunnerLog 'starting reverse SSH tunnel'
            $process = Start-Process `
                -FilePath $ssh `
                -ArgumentList $sshArgumentLine `
                -WindowStyle Hidden `
                -PassThru `
                -RedirectStandardOutput $stdoutFile `
                -RedirectStandardError $stderrFile
            Save-TrackedSshProcess -Process $process
        }
        catch {
            Write-RunnerLog "could not start SSH: $($_.Exception.Message)"
            Start-Sleep -Seconds 5
            continue
        }
    }

    $process.WaitForExit()
    $process.Refresh()
    $exitCode = $process.ExitCode
    Append-ProcessOutput
    $tracked = Get-TrackedSshProcess
    if (-not $tracked -or $tracked.Id -eq $process.Id) {
        Remove-Item -LiteralPath $processStateFile -Force -ErrorAction SilentlyContinue
    }
    Write-RunnerLog "SSH exited code=$exitCode"
    Start-Sleep -Seconds 5
}
