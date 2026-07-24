@echo off
REM `skipper` CLI Windows wrapper bundled with Skipper.
REM Lives at <install-dir>\resources\cli\skipper.bat. Resolves the
REM bundled JS in resources\cli-runtime via a relative path so
REM PATH-installed `skipper` works regardless of where Skipper is installed.
node "%~dp0..\cli-runtime\skipper.bundle.cjs" %*
