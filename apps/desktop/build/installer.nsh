; Custom NSIS directives for the Skipper installer.
; electron-builder auto-includes build/installer.nsh if it exists.

; Show the file-by-file extraction log during installation.
; MUI2 (used by electron-builder) defaults to hiding the details view
; behind the progress bar. This compile-time directive overrides that.
ShowInstDetails show
ShowUninstDetails show

; Note: PATH install for the bundled `skipper.bat` CLI shim happens via
; the in-app Settings → Command line panel on first run — same flow as on
; macOS. We deliberately do NOT manipulate HKCU Environment.Path from
; here: StrFunc.nsh's ${StrStr}/${StrRep} macros aren't included by
; electron-builder's base template, and getting them in safely across the
; mac-and-win matrix isn't worth a "save one click in Settings". The
; extraResources entry in apps/desktop/package.json ships skipper.bat at
; resources/cli/skipper.bat so the Settings install can find it.
