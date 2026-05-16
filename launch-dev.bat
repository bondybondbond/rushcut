@echo off
set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
start "" "C:\apps\rushcut\src-tauri\target\debug\rushcut.exe"
