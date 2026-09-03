#!/usr/bin/env bash
set -euo pipefail

project_folder="$(cd "$(dirname "$0")/.." && pwd)"
architecture_label="${1:-$(uname -m)}"
build_folder="$project_folder/.build/macos-$architecture_label"
release_folder="$project_folder/releases/current"
dist_folder="$build_folder/dist"
zip_path="$release_folder/ProjectFootMoneyball-macOS-$architecture_label.zip"

cd "$project_folder"
mkdir -p "$build_folder" "$release_folder"

python3 -m pip install --upgrade pip
python3 -m pip install -r requirements.txt
python3 -m pip install pyinstaller

python3 -m PyInstaller \
    --noconfirm \
    --clean \
    --onedir \
    --windowed \
    --workpath "$build_folder/work" \
    --distpath "$dist_folder" \
    --specpath "$build_folder" \
    --name "Project Foot Moneyball" \
    --osx-bundle-identifier "com.realdiceflame.projectfootmoneyball" \
    --add-data "$project_folder/data:data" \
    --add-data "$project_folder/resources:resources" \
    "$project_folder/app/desktop.py"

stage_root="$(mktemp -d)"
trap 'rm -rf "$stage_root"' EXIT
package_folder="$stage_root/Project Foot Moneyball"
mkdir -p "$package_folder"
ditto "$dist_folder/Project Foot Moneyball.app" "$package_folder/Project Foot Moneyball.app"
cp "$project_folder/resources/macos_release_readme.txt" "$package_folder/START HERE - README.txt"
rm -f "$zip_path"
ditto -c -k --sequesterRsrc --keepParent "$package_folder" "$zip_path"

echo "Finished: $zip_path"
