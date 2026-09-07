#!/bin/bash
# Double-click this to start PixInsight with the MCP watcher loaded.
cd "$(dirname "$0")/.." || exit 1
node scripts/pi-launch.mjs
echo
echo "Press any key to close this window."
read -n 1 -s
