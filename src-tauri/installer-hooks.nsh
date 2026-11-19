!macro NSIS_HOOK_PREUNINSTALL
  Push $R0
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "SimpleRay"
  StrCmp $R0 '"$INSTDIR\simpleray.exe" --minimized' 0 +2
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "SimpleRay"
  Pop $R0
!macroend
