#!/bin/sh
# Copies spidered contracts that the archive doesn't have yet into the archive.
#
#   sh scripts/archive/collect-new-contracts.sh <collected> <archive>
#
# <collected> holds one folder per successful market (the downloaded spider artifacts), each laid
# out as <network>/.contracts/<address>.json. Markets on the same network share files, so a file
# already copied from another market is skipped. Prints the number of files added.
set -e

collected=$1
archive=$2
added=0

for f in "$collected"/*/*/.contracts/*.json; do
  [ -e "$f" ] || continue
  network=$(basename "$(dirname "$(dirname "$f")")")
  dest="$archive/$network/.contracts/$(basename "$f")"
  [ -f "$dest" ] && continue
  mkdir -p "$(dirname "$dest")"
  cp "$f" "$dest"
  added=$((added + 1))
done

echo "$added"
