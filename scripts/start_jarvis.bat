@echo off
rem Starts Jarvis in the background (no console window).
cd /d "%~dp0.."
if exist ".venv\Scripts\pythonw.exe" (
    start "" ".venv\Scripts\pythonw.exe" jarvis_main.py
) else (
    start "" pythonw jarvis_main.py
)
