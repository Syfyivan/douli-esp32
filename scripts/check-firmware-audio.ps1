param([string]$SourceDir = (Join-Path $env:USERPROFILE '.cache\douli-firmware\xiaozhi'))
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$output = Join-Path $repo '.runtime\firmware-audio'
New-Item -ItemType Directory -Force -Path $output | Out-Null
& clang++ -std=c++20 -Wall -Wextra -Werror -I (Join-Path $SourceDir 'main\audio\engines') (Join-Path $repo 'tests\firmware-audio-levels.cc') -o (Join-Path $output 'audio-levels.exe')
if ($LASTEXITCODE -ne 0) { throw 'Audio level host compilation failed' }
& (Join-Path $output 'audio-levels.exe')
if ($LASTEXITCODE -ne 0) { throw 'Audio level checks failed' }
& clang++ -std=c++20 -Wall -Wextra -Werror -I (Join-Path $SourceDir 'main\audio\wake_words') (Join-Path $repo 'tests\firmware-wake-window.cc') -o (Join-Path $output 'wake-window.exe')
if ($LASTEXITCODE -ne 0) { throw 'Wake window host compilation failed' }
& (Join-Path $output 'wake-window.exe')
if ($LASTEXITCODE -ne 0) { throw 'Wake window checks failed' }
