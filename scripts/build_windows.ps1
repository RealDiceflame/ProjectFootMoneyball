$ErrorActionPreference = "Stop"
$ProjectFolder = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectFolder
$BuildFolder = Join-Path $ProjectFolder ".build"
$ReleaseFolder = Join-Path $ProjectFolder "releases\current"

python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python -m pip install pyinstaller

python -m PyInstaller `
    --noconfirm `
    --clean `
    --onedir `
    --windowed `
    --contents-directory . `
    --workpath $BuildFolder `
    --distpath $ReleaseFolder `
    --specpath $BuildFolder `
    --name ProjectFootMoneyball `
    --add-data "$ProjectFolder\data;data" `
    --add-data "$ProjectFolder\resources;resources" `
    "$ProjectFolder\app\desktop.py"

$Readme = @"
PROJECT FOOT MONEYBALL

1. Open ProjectFootMoneyball.exe.
2. Leave the ADP box blank to reuse the included snapshot, or paste a current ADP comparison URL.
3. Click Update Draft Board.
4. Click Open Spreadsheet when it finishes.

Internet access is required when downloading new stats or ADP.
Do not move the EXE out of this folder. Send the entire folder as a ZIP.
"@
Set-Content -Path "$ReleaseFolder\ProjectFootMoneyball\README.txt" -Value $Readme
Compress-Archive -Path "$ReleaseFolder\ProjectFootMoneyball\*" -DestinationPath "$ReleaseFolder\ProjectFootMoneyball-Windows.zip" -Force
Write-Host "Finished: releases\current\ProjectFootMoneyball-Windows.zip"
