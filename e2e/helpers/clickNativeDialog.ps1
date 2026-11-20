# clickNativeDialog.ps1 (#261) -- find a native Win32 dialog of ONE process by its title with
# Windows UI Automation, report its text and buttons, and press one button.
# WebDriver cannot reach a native dialog; UI Automation can. Nothing to install.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File clickNativeDialog.ps1 `
#          -ProcId <pid> -Title "<window title>" [-Button "<button name>"] [-TimeoutSec 20] [-InspectOnly]
# Prints ONE json line: { found, title, texts[], buttons[], clicked, error }
param(
  [Parameter(Mandatory = $true)][int]$ProcId,
  [Parameter(Mandatory = $true)][string]$Title,
  [string]$Button = "",
  [int]$TimeoutSec = 20,
  [string]$ShotPath = "",
  [switch]$InspectOnly
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
# DPI-aware, so UI Automation rectangles, mouse coordinates and the screenshot all use real pixels.
Add-Type -Namespace RcWin -Name Dpi -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[void][RcWin.Dpi]::SetProcessDPIAware()
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$PC = [System.Windows.Automation.PropertyCondition]
$result = [ordered]@{ found = $false; title = $Title; texts = @(); buttons = @(); clicked = ""; error = "" }

function Find-Dialog {
  $byPid = New-Object $PC ($AE::ProcessIdProperty), $ProcId
  $wins = $AE::RootElement.FindAll($TS::Children, $byPid)
  foreach ($w in $wins) { if ($w.Current.Name -eq $Title) { return $w } }
  # A modal dialog is an OWNED window: UI Automation often lists it under its owner, not under the desktop root.
  $byName = New-Object $PC ($AE::NameProperty), $Title
  foreach ($w in $wins) {
    $hit = $w.FindFirst($TS::Descendants, $byName)
    if ($hit) {
      # Climb to the dialog's own top element: the last ancestor below the owner window.
      $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
      $cur = $hit
      while ($true) {
        $parent = $walker.GetParent($cur)
        if (-not $parent) { break }
        if ($parent.Current.ProcessId -ne $ProcId -or $parent.Current.ClassName -eq "Tauri Window" -or $parent.Equals($AE::RootElement)) { break }
        $cur = $parent
      }
      return $cur
    }
  }
  return $null
}

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$dlg = $null
while ((Get-Date) -lt $deadline) {
  $dlg = Find-Dialog
  if ($dlg) { break }
  Start-Sleep -Milliseconds 250
}
if (-not $dlg) {
  # Diagnostics: any top-level window that carries the title (any process), or belongs to the target process.
  $diag = @()
  foreach ($w in $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    $n = $w.Current.Name
    if ($w.Current.ProcessId -eq $ProcId -or $n -like "*export*" -or $n -like "*Stop*") {
      $diag += ("pid={0} class={1} name={2}" -f $w.Current.ProcessId, $w.Current.ClassName, $n)
    }
  }
  foreach ($w in $AE::RootElement.FindAll($TS::Children, (New-Object $PC ($AE::ProcessIdProperty), $ProcId))) {
    foreach ($c in $w.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
      $diag += ("child-of-{0}: class={1} type={2} name={3}" -f $w.Current.ClassName, $c.Current.ClassName, $c.Current.ControlType.ProgrammaticName, $c.Current.Name)
    }
  }
  $result.windows = $diag
  $result.error = "dialog not found within $TimeoutSec s"; $result | ConvertTo-Json -Compress; exit 3
}
$result.found = $true

$all = $dlg.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$tree = @()
foreach ($e in $all) {
  $rc = $e.Current.BoundingRectangle
  $tree += ("{0} | class={1} | name={2} | rect={3},{4},{5},{6}" -f $e.Current.ControlType.ProgrammaticName, $e.Current.ClassName, $e.Current.Name, [int]$rc.X, [int]$rc.Y, [int]$rc.Width, [int]$rc.Height)
  if ($tree.Count -ge 40) { break }
}
$result.tree = $tree
$rd = $dlg.Current.BoundingRectangle
$result.topElement = ("{0} | class={1} | name={2} | rect={3},{4},{5},{6}" -f $dlg.Current.ControlType.ProgrammaticName, $dlg.Current.ClassName, $dlg.Current.Name, [int]$rd.X, [int]$rd.Y, [int]$rd.Width, [int]$rd.Height)
$btnEls = @()
foreach ($e in $all) {
  $ct = $e.Current.ControlType.ProgrammaticName
  # A Win32 TaskDialog exposes its buttons as ControlType.Pane with class CCPushButton (found by probe, #261).
  if ($ct -eq "ControlType.Button" -or $e.Current.ClassName -eq "CCPushButton") { $result.buttons += $e.Current.Name; $btnEls += $e }
  elseif ($ct -eq "ControlType.Text" -and $e.Current.Name) { $result.texts += $e.Current.Name }
}

if ($ShotPath) {
  # Screenshot of the dialog's own rectangle (what the owner would see), taken before any button is pressed.
  try {
    # PrintWindow renders THAT window only (never a screen copy, so nothing in front of it can leak in).
    Add-Type -AssemblyName System.Drawing
    Add-Type -Namespace RcWin -Name Pw -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool PrintWindow(System.IntPtr h,System.IntPtr dc,uint f);'
    Start-Sleep -Milliseconds 600
    $hw = [System.IntPtr]$dlg.Current.NativeWindowHandle
    if ($hw -eq [System.IntPtr]::Zero) { throw "dialog has no window handle" }
    $r = $dlg.Current.BoundingRectangle
    $bmp = New-Object System.Drawing.Bitmap ([int]$r.Width), ([int]$r.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    $okPw = [RcWin.Pw]::PrintWindow($hw, $hdc, 2)
    $g.ReleaseHdc($hdc)
    if (-not $okPw) { throw "PrintWindow failed" }
    $bmp.Save($ShotPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    $result.shot = $ShotPath
  } catch { $result.shotError = $_.Exception.Message }
}

if (-not $InspectOnly -and $Button) {
  $target = $btnEls | Where-Object { $_.Current.Name -eq $Button } | Select-Object -First 1
  if (-not $target) { $result.error = "button '$Button' not found"; $result | ConvertTo-Json -Compress; exit 4 }
  # Press the button: UIA Invoke, else the MSAA default action, else a real mouse click at its centre.
  $how = ""
  try {
    $inv = $target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $inv.Invoke(); $how = "invoke"
  } catch {
    try {
      $leg = $target.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
      $leg.DoDefaultAction(); $how = "legacy-default-action"
    } catch {
      try {
        # NEVER a mouse click: on a shared desktop it could land on someone else's window. Post the
        # dialog's own command straight to ITS window handle: TaskDialog buttons are IDOK (1) / IDCANCEL (2).
        Add-Type -Namespace RcWin -Name Msg -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h,uint m,System.IntPtr w,System.IntPtr l);'
        $hwnd = [System.IntPtr]$dlg.Current.NativeWindowHandle
        if ($hwnd -eq [System.IntPtr]::Zero) { throw "dialog has no window handle" }
        $id = if ($btnEls.IndexOf($target) -eq 0) { 1 } else { 2 }
        [void][RcWin.Msg]::PostMessage($hwnd, 0x0111, [System.IntPtr]$id, [System.IntPtr]::Zero); $how = "post-WM_COMMAND-$id"
      } catch { $result.error = "press failed: $($_.Exception.Message)"; $result | ConvertTo-Json -Compress; exit 5 }
    }
  }
  $result.clicked = $Button
  $result.how = $how
}
$result | ConvertTo-Json -Compress
