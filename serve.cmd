@echo off
REM Consilium needs to be served over http:// — browsers block ES modules on file://
cd /d "%~dp0"
start "" http://localhost:8000/
py -3 -m http.server 8000 2>nul || python -m http.server 8000
