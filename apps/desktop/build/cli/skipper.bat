@echo off
REM `skipper` CLI Windows wrapper bundled with Skipper.
REM Lives at <install-dir>\resources\cli\skipper.bat. Resolves the
REM bundled JS via a relative path so PATH-installed `skipper` works
REM regardless of where the user installed Skipper.
node "%~dp0..\web\apps\web\skipper.bundle.cjs" %*
