#!/bin/sh
# solidity-coverage finds sources with a `contracts/**/*.sol` glob. The capo submodule commits
# its ABI exports in folders named after the source file (abi/json/.../IERC20.sol/IERC20.json),
# so the glob picks those folders up and the run crashes reading them as Solidity files.
# Move capo's abi/ out of the tree for the run and always put it back afterwards.
#
# The submodule shows as dirty while coverage runs. In CI the submodule isn't checked out,
# so there is nothing to move.
set -eu

ABI=contracts/capo/abi
# Fixed location (gitignored), not mktemp, so a run killed with SIGKILL can be recovered.
BACKUP=.coverage-capo-abi

restore() {
  if [ -d "$BACKUP/abi" ]; then
    if [ -e "$ABI" ]; then
      echo "coverage.sh: both $ABI and $BACKUP/abi exist; restore $ABI by hand" >&2
      return 1
    fi
    mv "$BACKUP/abi" "$ABI"
    rmdir "$BACKUP"
  fi
}

# Recover from a previous run that was killed before it could clean up.
restore

if [ -d "$ABI" ]; then
  mkdir -p "$BACKUP"
  mv "$ABI" "$BACKUP/abi"
  trap restore EXIT
  trap 'exit 130' INT TERM
fi

NODE_OPTIONS='--max-old-space-size=8192' hardhat coverage "$@"
