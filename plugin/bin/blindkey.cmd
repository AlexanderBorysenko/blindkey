@echo off
rem blindkey agent CLI (Claude Code plugin bin/). Runs the bundled agent-mode CLI next to this file.
setlocal
set BLINDKEY_AGENT=1
node "%~dp0..\dist\blindkey.mjs" %*
exit /b %ERRORLEVEL%
