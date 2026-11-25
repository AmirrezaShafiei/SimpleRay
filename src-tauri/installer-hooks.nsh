!macro NSIS_HOOK_PREINSTALL
  ; A running SimpleRay must exit normally to restore Windows System Proxy.
  ; If only a leftover core is running, stop the one from this install directory.
  Push $0
  Push $1
  IfFileExists "$INSTDIR\binaries\xray.exe" simpleray_check_core
  IfFileExists "$INSTDIR\simpleray.exe" simpleray_check_core simpleray_check_done

  simpleray_check_core:
  System::Call 'kernel32::SetEnvironmentVariableW(w "SIMPLERAY_SETUP_PATH", w "$INSTDIR") i .r1'
  StrCpy $0 "error"
  StrCmp $1 "0" simpleray_check_failed
  StrCpy $0 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  IfFileExists "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" 0 +2
  StrCpy $0 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  nsExec::Exec /TIMEOUT=15000 `"$0" -NoLogo -NoProfile -NonInteractive -Command "$$ErrorActionPreference='Stop'; try { \
    $$root=$$env:SIMPLERAY_SETUP_PATH; \
    $$app=Join-Path $$root 'simpleray.exe'; \
    $$core=Join-Path $$root 'binaries\xray.exe'; \
    if (Get-Process -Name simpleray -ErrorAction SilentlyContinue | Where-Object Path -EQ $$app) { exit 2 }; \
    if (Test-Path -LiteralPath $$app) { [IO.File]::Open($$app,'Open','ReadWrite','None').Dispose() }; \
    Get-Process -Name xray -ErrorAction SilentlyContinue | Where-Object Path -EQ $$core | ForEach-Object { \
      $$_.Kill(); if (!$$_.WaitForExit(5000)) { throw 'Xray did not exit' } \
    }; \
    if (Test-Path -LiteralPath $$core) { [IO.File]::Open($$core,'Open','ReadWrite','None').Dispose() }; \
    exit 0 \
  } catch { exit 3 }"`
  Pop $0
  System::Call 'kernel32::SetEnvironmentVariableW(w "SIMPLERAY_SETUP_PATH", p 0) i'
  StrCmp $0 "0" simpleray_check_done

  simpleray_check_failed:
  DetailPrint "Could not prepare SimpleRay for upgrade (status $0)."
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Setup cannot replace SimpleRay or its Xray engine.$\r$\nChoose Exit from the SimpleRay tray icon, then click Retry. If the file is still in use, restart Windows and exit SimpleRay before running Setup again." /SD IDCANCEL IDRETRY simpleray_check_core
  Pop $1
  Pop $0
  SetErrorLevel 1
  Abort

  simpleray_check_done:
  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Push $R0
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "SimpleRay"
  StrCmp $R0 '"$INSTDIR\simpleray.exe" --minimized' 0 +2
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "SimpleRay"
  Pop $R0
!macroend
