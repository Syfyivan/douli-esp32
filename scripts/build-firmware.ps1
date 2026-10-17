param(
    [string]$SourceDir = (Join-Path $env:USERPROFILE '.cache\douli-firmware\xiaozhi')
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$sourceCommit = '49b4380b3faa0ceadd28a3e78aaf0f311c46c57e'
$patchPath = Join-Path $repoRoot 'firmware\douli-persistent-connection.patch'
$artifactDir = Join-Path $repoRoot '.runtime\firmware-repair'

# Windows PowerShell 5 treats redirected native stderr as an error record.
# Build tools use stderr for warnings, so judge native commands by exit code.
function Invoke-CheckedNative([string]$Program, [string[]]$ProgramArgs) {
    $ErrorActionPreference = 'Continue'
    & $Program @ProgramArgs
    if ($LASTEXITCODE -ne 0) { throw "$Program exited with code $LASTEXITCODE." }
}

if (-not $env:IDF_PATH) { throw 'Export the ESP-IDF 6.1 environment first (export.ps1).' }
if (-not (Test-Path -LiteralPath $SourceDir)) {
    Invoke-CheckedNative git @('clone', '--depth', '1', '--branch', 'v2.5.2', 'https://github.com/78/xiaozhi-esp32.git', $SourceDir)
}
$actualCommit = (Invoke-CheckedNative git @('-C', $SourceDir, 'rev-parse', 'HEAD')).Trim()
if ($actualCommit -ne $sourceCommit) {
    throw "Expected upstream commit $sourceCommit; found $actualCommit. Use a separate checkout."
}
$ErrorActionPreference = 'Continue'
git -C $SourceDir apply --reverse --check $patchPath 2>$null
$reverseCheck = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($reverseCheck -ne 0) {
    Invoke-CheckedNative git @('-C', $SourceDir, 'apply', '--check', $patchPath)
    Invoke-CheckedNative git @('-C', $SourceDir, 'apply', $patchPath)
}

$env:PYTHONUTF8 = '1'
Push-Location -LiteralPath $SourceDir
try {
    Invoke-CheckedNative python @('scripts/build.py', 'waveshare/esp32-s3-audio-board', '--name', 'esp32-s3-audio-board')
    $app = Join-Path $SourceDir 'build\xiaozhi.bin'
    if ((Get-Item -LiteralPath $app).Length -gt 0x3f0000) { throw 'Application exceeds the existing OTA partition.' }
    New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null
    $project = Get-Content -Raw -LiteralPath (Join-Path $SourceDir 'CMakeLists.txt')
    if ($project -notmatch 'set\(PROJECT_VER "([0-9.]+)"\)') { throw 'Cannot read firmware version.' }
    $output = Join-Path $artifactDir ('app-' + $Matches[1] + '.bin')
    Copy-Item -LiteralPath $app -Destination $output
    Get-FileHash -Algorithm SHA256 -LiteralPath $output
    Write-Output 'Build only. Flash the application only after checking the actual device partition table and a current backup.'
} finally {
    Pop-Location
}
