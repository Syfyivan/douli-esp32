param([string]$SourceDir = (Join-Path $env:USERPROFILE '.cache\douli-firmware\xiaozhi'))
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$test = Join-Path $repo 'tests\firmware-backend-selection'
$output = Join-Path $repo '.runtime\backend-selection'
$json = Join-Path $SourceDir 'managed_components\espressif__cjson\cJSON'
New-Item -ItemType Directory -Force -Path $output | Out-Null
& clang -c (Join-Path $json 'cJSON.c') -o (Join-Path $output 'cJSON.o')
if ($LASTEXITCODE -ne 0) { throw 'cJSON host compilation failed' }
& clang++ -std=c++20 -Wall -Wextra -I $test -I $json -I (Join-Path $SourceDir 'main') (Join-Path $test 'state.cc') (Join-Path $SourceDir 'main\backend_selection.cc') (Join-Path $output 'cJSON.o') -o (Join-Path $output 'firmware-state.exe')
if ($LASTEXITCODE -ne 0) { throw 'Firmware state host compilation failed' }
& (Join-Path $output 'firmware-state.exe')
if ($LASTEXITCODE -ne 0) { throw 'Firmware state checks failed' }
