param([string]$Config = "$PSScriptRoot\companion.config.json")
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 22 or newer before starting the Kiln companion.' }
& node "$PSScriptRoot\companion.mjs" $Config
