# diagnose-freeze.ps1 -- Batch U5c (GitHub Issue #2)
# READ-ONLY diagnostic capture for the dual-monitor / GPU-driver-TDR freeze.
# Run this IMMEDIATELY after a freeze recovers. It changes NOTHING on the system.
#
# Usage (from PowerShell, no admin needed for most sections):
#   powershell -ExecutionPolicy Bypass -File C:\apps\rushcut\scripts\diagnose-freeze.ps1
#
# Output: a single ASCII report at %TEMP%\rushcut\freeze-report-<timestamp>.txt
# Paste that file back to Claude. ASCII-only output (cp1252 rule).

param(
    [int]$Minutes = 15   # event-log lookback window; 15 min survives the ~30s freeze + script-launch delay
)

$ErrorActionPreference = "Continue"

$stamp   = Get-Date -Format "yyyyMMdd-HHmmss"
$tempDir = Join-Path $env:TEMP "rushcut"
if (-not (Test-Path $tempDir)) { New-Item -ItemType Directory -Path $tempDir -Force | Out-Null }
$report  = Join-Path $tempDir "freeze-report-$stamp.txt"

$lines = New-Object System.Collections.Generic.List[string]
function Add-Line([string]$s) { $lines.Add($s) }
function Add-Section([string]$title) {
    Add-Line ""
    Add-Line ("=" * 70)
    Add-Line ("== " + $title)
    Add-Line ("=" * 70)
}

Add-Line "RushCut freeze diagnostic report"
Add-Line ("Generated: " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss K"))
Add-Line ("Lookback window: last $Minutes minutes")
Add-Line ("Machine: " + $env:COMPUTERNAME + " | User: " + $env:USERNAME)

# ---------------------------------------------------------------------------
# 1. TDR / display-driver-reset events (the authoritative evidence)
#
# AMD GPU TDR (VIDEO_TDR_FAILURE, P1=141) appears in the APPLICATION log
# as WER Event 1001 with Event Name: LiveKernelEvent -- NOT in System log.
# The WATCHDOG dump filename contains the exact crash timestamp.
# System log ID 41 (Kernel-Power hard reset) is also checked as fallback.
# ---------------------------------------------------------------------------
Add-Section "TDR / DISPLAY DRIVER EVENTS (last $Minutes min)"

$start   = (Get-Date).AddMinutes(-$Minutes)
$tdrFound = $false

# Application log -- WER LiveKernelEvent P1=141 (AMD GPU watchdog / VIDEO_TDR_FAILURE)
try {
    $werEvents = Get-WinEvent -FilterHashtable @{
        LogName   = 'Application'
        StartTime = $start
        Id        = 1001
    } -ErrorAction SilentlyContinue | Where-Object { $_.Message -like '*141*' -and $_.Message -like '*LiveKernelEvent*' }
    if ($werEvents) {
        Add-Line ("Found " + ($werEvents | Measure-Object).Count + " WER LiveKernelEvent (P1=141) in Application log:")
        foreach ($e in ($werEvents | Sort-Object TimeCreated)) {
            $watchdog = ""
            if ($e.Message -match 'WATCHDOG\\(WATCHDOG-[0-9\-]+\.dmp)') { $watchdog = "  watchdog=" + $Matches[1] }
            Add-Line ("  [" + $e.TimeCreated.ToString("HH:mm:ss") + "] WER-1001 LiveKernelEvent P1=141$watchdog")
        }
        Add-Line ""
        Add-Line ">>> VERDICT: GPU watchdog timeout (VIDEO_TDR_FAILURE P1=141) CONFIRMED."
        $tdrFound = $true
    }
} catch {
    Add-Line ("ERROR reading Application log: " + $_.Exception.Message)
}

# System log -- Kernel-Power ID 41 (hard reset) + driver errors 4097/4098
try {
    $sysEvents = Get-WinEvent -FilterHashtable @{
        LogName   = 'System'
        StartTime = $start
        Id        = 41, 4097, 4098
    } -ErrorAction SilentlyContinue
    if ($sysEvents) {
        foreach ($e in ($sysEvents | Sort-Object TimeCreated)) {
            $msg = ($e.Message -replace "`r`n", " " -replace "`n", " ")
            if ($msg.Length -gt 200) { $msg = $msg.Substring(0, 200) + "..." }
            Add-Line ("  [" + $e.TimeCreated.ToString("HH:mm:ss") + "] id=" + $e.Id + " " + $e.ProviderName + " :: " + $msg)
        }
        $tdrFound = $true
    }
} catch {
    Add-Line ("ERROR reading System log: " + $_.Exception.Message)
}

if (-not $tdrFound) {
    Add-Line "No TDR events found (Application WER P1=141 or System id 41/4097/4098)."
    Add-Line ">>> WER events appear ~1 min after recovery. Re-run sooner or widen -Minutes if freeze just happened."
}

# ---------------------------------------------------------------------------
# 2. MPO (Multiplane Overlay) state -- #1 AMD + Chromium multi-monitor culprit
#    Known fix: OverlayTestMode = 5 (DWORD) disables MPO.
# ---------------------------------------------------------------------------
Add-Section "MPO (MULTIPLANE OVERLAY) STATE -- registry, READ ONLY"
try {
    $dwmKey = "HKLM:\SOFTWARE\Microsoft\Windows\Dwm"
    $otm = (Get-ItemProperty -Path $dwmKey -Name "OverlayTestMode" -ErrorAction SilentlyContinue).OverlayTestMode
    if ($null -eq $otm) {
        Add-Line "OverlayTestMode: NOT SET (MPO enabled = default)."
        Add-Line ">>> FOLLOW-UP FIX CANDIDATE (top): set OverlayTestMode = 5 (DWORD) to disable MPO."
    } elseif ($otm -eq 5) {
        Add-Line "OverlayTestMode: 5 (MPO already disabled). MPO is NOT the cause."
    } else {
        Add-Line ("OverlayTestMode: " + $otm + " (not 5).")
        Add-Line ">>> FOLLOW-UP FIX CANDIDATE: set OverlayTestMode = 5 (DWORD) to disable MPO."
    }
} catch {
    Add-Line ("ERROR reading DWM key: " + $_.Exception.Message)
}

# ---------------------------------------------------------------------------
# 3. GPU adapter(s) + driver version/date
# ---------------------------------------------------------------------------
Add-Section "GPU ADAPTER(S)"
try {
    Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | ForEach-Object {
        Add-Line ("Name:        " + $_.Name)
        Add-Line ("  DriverVer: " + $_.DriverVersion + "  DriverDate: " + $_.DriverDate)
        Add-Line ("  Mode:      " + $_.CurrentHorizontalResolution + "x" + $_.CurrentVerticalResolution +
                  " @ " + $_.CurrentRefreshRate + "Hz")
        Add-Line ("  Status:    " + $_.Status + "  VRAM(bytes): " + $_.AdapterRAM)
    }
} catch {
    Add-Line ("ERROR reading video controllers: " + $_.Exception.Message)
}

# ---------------------------------------------------------------------------
# 4. TDR registry settings (GraphicsDrivers) -- READ ONLY
# ---------------------------------------------------------------------------
Add-Section "TDR REGISTRY SETTINGS -- READ ONLY"
try {
    $gdKey = "HKLM:\SYSTEM\CurrentControlSet\Control\GraphicsDrivers"
    $delay = (Get-ItemProperty -Path $gdKey -Name "TdrDelay" -ErrorAction SilentlyContinue).TdrDelay
    $level = (Get-ItemProperty -Path $gdKey -Name "TdrLevel" -ErrorAction SilentlyContinue).TdrLevel
    Add-Line ("TdrDelay: " + $(if ($null -eq $delay) { "NOT SET (default 2s)" } else { "$delay s" }))
    Add-Line ("TdrLevel: " + $(if ($null -eq $level) { "NOT SET (default 3 = recover)" } else { $level }))
} catch {
    Add-Line ("ERROR reading GraphicsDrivers key: " + $_.Exception.Message)
}

# ---------------------------------------------------------------------------
# 5. Connected displays + refresh rates (mixed-refresh check)
# ---------------------------------------------------------------------------
Add-Section "CONNECTED DISPLAYS"
try {
    $mons = Get-CimInstance Win32_DesktopMonitor -ErrorAction SilentlyContinue
    Add-Line ("Monitor count (Win32_DesktopMonitor): " + ($mons | Measure-Object).Count)
    $mons | ForEach-Object {
        Add-Line ("  " + $_.Name + " | " + $_.DeviceID + " | status=" + $_.Status)
    }
    Add-Line "Per-adapter refresh rate is listed in the GPU ADAPTER(S) section above."
    Add-Line "(Mixed refresh rates across monitors are a known multi-monitor TDR amplifier.)"
} catch {
    Add-Line ("ERROR reading monitors: " + $_.Exception.Message)
}

# ---------------------------------------------------------------------------
# 6. Background GPU activity correlation + app playback trace (log tails)
# ---------------------------------------------------------------------------
Add-Section "LOG TAILS (background AMF activity + app playback trace)"
$logs = @(
    @{ Name = "playback-trace.log (app seek/play events)"; File = "playback-trace.log"; Tail = 60 },
    @{ Name = "proxy-bg.log (background proxy AMF)";        File = "proxy-bg.log";        Tail = 25 },
    @{ Name = "zoom-bg.log (background zoom-warm AMF)";     File = "zoom-bg.log";         Tail = 25 },
    @{ Name = "pipeline-latest.log (active render)";        File = "pipeline-latest.log"; Tail = 15 }
)
foreach ($l in $logs) {
    Add-Line ""
    Add-Line ("--- " + $l.Name + " ---")
    $path = Join-Path $tempDir $l.File
    if (Test-Path $path) {
        try {
            Get-Content -Path $path -Tail $l.Tail -ErrorAction SilentlyContinue | ForEach-Object { Add-Line ("  " + $_) }
        } catch {
            Add-Line ("  ERROR tailing: " + $_.Exception.Message)
        }
    } else {
        Add-Line "  (not present)"
    }
}

# ---------------------------------------------------------------------------
# Write report (ASCII) + echo path
# ---------------------------------------------------------------------------
$lines | Out-File -FilePath $report -Encoding ascii
Write-Host ""
Write-Host "Report written to: $report"
Write-Host "Paste that file's contents back to Claude."
Write-Host ""
# Also echo the TDR verdict line to the console for a quick at-a-glance result.
$lines | Where-Object { $_ -like "*VERDICT*" -or $_ -like "*FOLLOW-UP FIX CANDIDATE*" } | ForEach-Object { Write-Host $_ }
