#!/bin/bash
# Double-click this to stop the PixInsight watcher.
# PixInsight itself stays open with its images.
cd "$(dirname "$0")/.." || exit 1
node scripts/pi-stop.mjs
echo
echo "Press any key to close this window."
read -n 1 -s
