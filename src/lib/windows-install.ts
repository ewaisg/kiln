export function isWindowsDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /Windows/i.test(nav.userAgentData?.platform || navigator.userAgent);
}

export function downloadWindowsInstaller(): void {
  const origin = window.location.origin;
  if (!/^https?:\/\//.test(origin) || /["%\r\n]/.test(origin)) return;
  const lines = [
    "@echo off",
    "setlocal",
    `set "KILN_URL=${origin}"`,
    'set "EDGE=%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe"',
    'if not exist "%EDGE%" set "EDGE=%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe"',
    'if not exist "%EDGE%" set "EDGE=%LocalAppData%\\Google\\Chrome\\Application\\chrome.exe"',
    'if not exist "%EDGE%" (',
    "  echo Install Microsoft Edge or Google Chrome, then run this again.",
    "  pause",
    "  exit /b 1",
    ")",
    'powershell -NoProfile -Command "$w=New-Object -ComObject WScript.Shell; $launch=\'--app=\'+$env:KILN_URL+\' --start-maximized\'; foreach($folder in @($w.SpecialFolders(\'Programs\'),$w.SpecialFolders(\'Desktop\'))){ $s=$w.CreateShortcut((Join-Path $folder \'Kiln.lnk\')); $s.TargetPath=$env:EDGE; $s.Arguments=$launch; $s.Description=\'Kiln\'; $s.Save() }"',
    'start "" "%EDGE%" --app="%KILN_URL%" --start-maximized',
    "",
  ];
  const blob = new Blob([lines.join("\r\n")], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "Install-Kiln.bat";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
