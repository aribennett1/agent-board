#!/usr/bin/env bash
# agent-board-supervise
# Restart the board quickly if it crashes. Stop the tmux session to stop this loop.
set -uo pipefail

BOARD_DIR=/workspace/agent-board
LOG=/workspace/agent-board-data/server.log
BACKOFF=2

cd "${BOARD_DIR}" || exit 1
mkdir -p /workspace/agent-board-data

echo "$(date -Iseconds) supervisor starting" >>"${LOG}"
until npm start 2>&1 | tee -a "${LOG}"; do
  status=${PIPESTATUS[0]:-$?}
  echo "$(date -Iseconds) board exited ${status}; restarting in ${BACKOFF}s" >>"${LOG}"
  sleep "${BACKOFF}"
done
echo "$(date -Iseconds) board exited 0; supervisor stopping" >>"${LOG}"
