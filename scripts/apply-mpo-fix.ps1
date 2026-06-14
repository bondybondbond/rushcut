# apply-mpo-fix.ps1 -- Batch U5c follow-up (GitHub Issue #2)
# Disables Multiplane Overlay (MPO) -- the #1 confirmed AMD + Chromium dual-monitor TDR cause.
# Requires admin. Run once; survives reboots. Recommended: reboot after applying.
#
# Reversal (if anything feels wrong):
#   Remove-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows\Dwm" -Name "OverlayTestMode" -Force
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File C:\apps\rushcut\scripts\apply-mpo-fix.ps1

$key  = "HKLM:\SOFTWARE\Microsoft\Windows\Dwm"
$name = "OverlayTestMode"
$val  = 5

try {
    New-ItemProperty -Path $key -Name $name -Value $val -PropertyType DWORD -Force | Out-Null
    $written = (Get-ItemProperty -Path $key -Name $name -ErrorAction Stop).$name
    if ($written -eq $val) {
        Write-Host ""
        Write-Host "MPO DISABLED. OverlayTestMode = $written"
        Write-Host ""
        Write-Host "Recommended: reboot so DWM picks up the change cleanly."
        Write-Host "Reversal:    Remove-ItemProperty -Path '$key' -Name '$name' -Force"
        Write-Host ""
    } else {
        Write-Host "ERROR: wrote value but read back $written (expected $val)."
    }
} catch {
    Write-Host ""
    Write-Host "ERROR: $($_.Exception.Message)"
    Write-Host "Re-run this script as Administrator (right-click PowerShell -> Run as administrator)."
    Write-Host ""
}
