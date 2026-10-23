@echo off
rem One-time install: virtual environment, dependencies, then the setup questions.
cd /d "%~dp0.."
py -3 -m venv .venv || python -m venv .venv
call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install -r requirements.txt
python setup_wizard.py
pause
