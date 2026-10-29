; Producer Studio's uninstaller asks whether to remove what it otherwise leaves behind (D-15): the VoiceStudio runtime
; (10 GB or more; Voice Studio → Engine installs it again) and the data on this computer (projects, media, renders,
; settings, saved keys). Both answers default to No. Never asked during an update (the old version's uninstaller runs
; with --updated) or in a silent uninstall (/S answers No). A data folder moved elsewhere (Settings → Storage) is not
; touched: the uninstaller can't read settings.json, and says so.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    IfFileExists "$LOCALAPPDATA\Producer Studio\VoiceStudio\*.*" 0 ps_skip_voicestudio
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also remove the VoiceStudio engine (voice cloning, dubbing, dictation)?$\r$\n$\r$\nIt takes 10 GB or more in $LOCALAPPDATA\Producer Studio\VoiceStudio. Your voices are kept with your data. If you install Producer Studio again, Voice Studio → Engine installs it again." /SD IDNO IDNO ps_skip_voicestudio
      RMDir /r "$LOCALAPPDATA\Producer Studio\VoiceStudio"
    ps_skip_voicestudio:
    MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "Also delete your Producer Studio data on this computer?$\r$\n$\r$\nThis removes your local projects, media, renders, voices, settings and saved keys ($LOCALAPPDATA\Producer Studio and $APPDATA\Producer Studio). Projects that aren't synced to your cloud account are lost for good.$\r$\n$\r$\nA data folder you moved somewhere else isn't touched. Choose No to keep everything for a later install." /SD IDNO IDNO ps_keep_data
      RMDir /r "$LOCALAPPDATA\Producer Studio"
      RMDir /r "$APPDATA\Producer Studio"
    ps_keep_data:
  ${endIf}
!macroend
