@echo off
rem pidb agent CLI (Claude Code plugin bin/). Runs the bundled agent-mode CLI next to this file.
setlocal
set PIDB_AGENT=1
node "%~dp0..\dist\pidb.mjs" %*
exit /b %ERRORLEVEL%
