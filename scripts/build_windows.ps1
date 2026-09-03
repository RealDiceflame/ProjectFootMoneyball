$ErrorActionPreference = "Stop"
$ProjectFolder = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectFolder
$BuildFolder = Join-Path $ProjectFolder ".build"
$ReleaseFolder = Join-Path $ProjectFolder "releases\current"
$DistFolder = Join-Path $BuildFolder "dist"
$BundledPython = Join-Path $ProjectFolder ".standalone-build-venv\Scripts\python.exe"
$Python = if (Test-Path $BundledPython) { $BundledPython } else { "python" }

& $Python -m pip install --upgrade pip
& $Python -m pip install -r requirements.txt
& $Python -m pip install pyinstaller

& $Python -m PyInstaller `
    --noconfirm `
    --clean `
    --onedir `
    --windowed `
    --workpath $BuildFolder `
    --distpath $DistFolder `
    --specpath $BuildFolder `
    --name "Project Foot Moneyball" `
    --add-data "$ProjectFolder\data;data" `
    --add-data "$ProjectFolder\resources;resources" `
    "$ProjectFolder\app\desktop.py"

$AppFolder = Join-Path $DistFolder "Project Foot Moneyball"
$Readme = @"
PROJECT FOOT MONEYBALL

1. Double-click Project Foot Moneyball.exe.
2. Leave the ADP box blank to reuse the included snapshot, or paste a current ADP comparison URL.
3. Click Update Draft Board.
4. Click Open Spreadsheet when it finishes.

Internet access is required when downloading new stats or ADP.
Do not move the EXE out of this folder. Send the entire folder as a ZIP.
"@
Set-Content -Path "$AppFolder\START HERE - README.txt" -Value $Readme
Compress-Archive -Path "$AppFolder\*" -DestinationPath "$ReleaseFolder\ProjectFootMoneyball-Windows.zip" -Force
Write-Host "Finished: releases\current\ProjectFootMoneyball-Windows.zip"
