$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
try {
    $response = Invoke-WebRequest -Uri 'http://127.0.0.1:8080/' -TimeoutSec 2 -UseBasicParsing
    if ($response.StatusCode -eq 200) { exit 0 }
} catch { }
# npm scripts preserve the app environment wrapper on Windows, too.
Start-Process -FilePath 'cmd.exe' -ArgumentList '/d', '/c', 'npm run dev' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot '.grok/dev.log') -RedirectStandardError (Join-Path $PSScriptRoot '.grok/dev-error.log')
