@echo off
cd /d "%~dp0"
if "%MIX0GRAU_ADMIN_PIN%"=="" (
 echo Defina o PIN antes de iniciar: set MIX0GRAU_ADMIN_PIN=senha-segura
 pause
 exit /b 1
)
py server.py
pause
