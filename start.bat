@echo off
cd /d "%~dp0"
start "" http://localhost:4400
node server.mjs
pause
