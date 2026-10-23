# Adds Jarvis to Windows autostart, so the clap listener runs after every login.
#   powershell -ExecutionPolicy Bypass -File scripts\install_autostart.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install_autostart.ps1 -Remove

param([switch]$Remove)

$startup  = [Environment]::GetFolderPath("Startup")
$shortcut = Join-Path $startup "Jarvis.lnk"

if ($Remove) {
    Remove-Item $shortcut -ErrorAction SilentlyContinue
    Write-Host "Jarvis removed from autostart."
    exit
}

$root = Split-Path -Parent $PSScriptRoot
$wsh  = New-Object -ComObject WScript.Shell
$lnk  = $wsh.CreateShortcut($shortcut)
$lnk.TargetPath       = Join-Path $root "scripts\start_jarvis.bat"
$lnk.WorkingDirectory = $root
$lnk.WindowStyle      = 7  # minimized
$lnk.Save()
Write-Host "Jarvis will start automatically at login ($shortcut)."
