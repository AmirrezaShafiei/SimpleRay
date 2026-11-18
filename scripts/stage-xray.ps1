# Stage a user-downloaded, independently SHA256-verified official Xray Windows release.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\stage-xray.ps1 -Archive C:\Downloads\Xray-windows-64.zip -Sha256 <trusted SHA256>
# Never download or execute unverified binaries from an arbitrary subscription link.
param(
    [Parameter(Mandatory=$true)] [string] $Archive,
    [Parameter(Mandatory=$true)] [string] $Sha256
)
$ErrorActionPreference = 'Stop'
$Archive = (Resolve-Path -LiteralPath $Archive).Path
$Sha256 = $Sha256.Trim().ToUpperInvariant()
if ($Sha256 -notmatch '^[A-F0-9]{64}$') { throw 'SHA256 must be exactly 64 hexadecimal characters' }
$actual = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToUpperInvariant()
if ($actual -ne $Sha256) { throw 'SHA256 mismatch. Refusing to extract the Xray binary.' }
$temp = Join-Path $env:TEMP ([System.IO.Path]::GetRandomFileName())
try {
    New-Item -Type Directory -Path $temp | Out-Null
    Expand-Archive -LiteralPath $Archive -DestinationPath $temp
    $exe = Get-ChildItem -LiteralPath $temp -Filter 'xray.exe' -File -Recurse | Select-Object -First 1
    if (-not $exe) { throw 'No xray.exe found in verified archive.' }
    $target = Join-Path $PSScriptRoot '..\src-tauri\binaries\xray.exe'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
    Copy-Item -LiteralPath $exe.FullName -Destination $target -Force
    Write-Host "Verified Xray-core staged at $target"
    Write-Host 'Run npm run desktop:dev to test the native app on Windows.'
} finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
}
