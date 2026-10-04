#!/bin/sh
# Assembles the phone app into _site/ from web/ plus the shared app/ code.
# Used by the GitHub Pages workflow and for local testing.
set -eu
cd "$(dirname "$0")/.."
rm -rf _site
mkdir -p _site/icons
cp -R web/. _site/
cp -R extension/app _site/app
cp web/icons/*.png _site/icons/
VERSION="${1:-$(git rev-parse --short HEAD 2>/dev/null || date +%s)}"
sed -i.bak "s/__VERSION__/$VERSION/" _site/sw.js && rm _site/sw.js.bak
echo "built _site/ (version $VERSION)"
