#!/usr/bin/env bash
# Idempotent start for Tailscale (userspace) and the agent board.
# Safe to run at boot, from a shell hook, or by hand. No notifications.
set -euo pipefail

OPS_DIR=/workspace/agent-board-ops
BOARD_DIR=/workspace/agent-board
DATA_DIR=/workspace/agent-board-data
START_LOG=${OPS_DIR}/start.log
LOCK=${OPS_DIR}/start.lock
TS_STATE_LIVE=/var/lib/tailscale
TS_STATE_BACKUP=${OPS_DIR}/tailscale-state
TS_SOCKET=/run/tailscale/tailscaled.sock
TS_BIN=/usr/sbin/tailscaled
TMUX_SESSION=agent-board
SUPERVISE=${OPS_DIR}/supervise-board.sh
HOOK_SRC=${OPS_DIR}/xfce4-panel.hook
HOOK_WRAPPER=${HOME}/.local/bin/xfce4-panel
BASHRC=${HOME}/.bashrc

mkdir -p "${OPS_DIR}" "${DATA_DIR}"

if [ -f "${START_LOG}" ]; then
  log_size=$(wc -c <"${START_LOG}" 2>/dev/null || echo 0)
  if [ "${log_size}" -gt 1000000 ]; then
    tail -c 200000 "${START_LOG}" >"${START_LOG}.tmp" && mv -f "${START_LOG}.tmp" "${START_LOG}"
  fi
fi

exec 9>"${LOCK}"
if ! flock -w 30 9; then
  exit 0
fi

log() {
  printf '%s %s\n' "$(date -Iseconds)" "$*" >>"${START_LOG}"
}

backend_state() {
  tailscale --socket="${TS_SOCKET}" status --json 2>/dev/null \
    | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("BackendState",""))
except Exception:
    print("")' 2>/dev/null || true
}

port_in_use() {
  ss -ltn 2>/dev/null | grep -qE ':8787[[:space:]]'
}

ensure_hooks() {
  mkdir -p "${HOME}/.local/bin"
  if [ ! -f "${HOOK_SRC}" ]; then
    log "missing ${HOOK_SRC}"
  elif [ ! -e "${HOOK_WRAPPER}" ] || grep -q 'agent-board-boot-hook' "${HOOK_WRAPPER}" 2>/dev/null; then
    cp -f "${HOOK_SRC}" "${HOOK_WRAPPER}"
    chmod 0755 "${HOOK_WRAPPER}"
  else
    log "left ${HOOK_WRAPPER} in place; it is not our boot hook"
  fi

  if [ ! -x /usr/bin/xfce4-panel ]; then
    log "warning: /usr/bin/xfce4-panel is missing"
  fi

  python3 "${OPS_DIR}/install-bashrc-hook.py" "${BASHRC}"
}

restore_tailscale_state_if_needed() {
  sudo -n mkdir -p "${TS_STATE_LIVE}"
  sudo -n chmod 700 "${TS_STATE_LIVE}"
  if sudo -n test -s "${TS_STATE_LIVE}/tailscaled.state"; then
    return 0
  fi
  if sudo -n test -s "${TS_STATE_BACKUP}/tailscaled.state"; then
    sudo -n cp -a "${TS_STATE_BACKUP}/." "${TS_STATE_LIVE}/"
    sudo -n chmod 700 "${TS_STATE_LIVE}"
    log "restored tailscale state from persistent backup"
  fi
}

backup_tailscale_state() {
  if ! sudo -n test -s "${TS_STATE_LIVE}/tailscaled.state"; then
    return 0
  fi
  local tmp=${TS_STATE_BACKUP}.tmp
  sudo -n rm -rf "${tmp}"
  sudo -n mkdir -p "${tmp}"
  sudo -n chmod 700 "${tmp}"
  sudo -n bash -c '
    live="$1"
    tmp="$2"
    for path in "$live"/*; do
      [ -e "$path" ] || continue
      base=$(basename "$path")
      case "$base" in
        tailscaled.log*) continue ;;
      esac
      cp -a "$path" "$tmp/"
    done
  ' bash "${TS_STATE_LIVE}" "${tmp}"
  sudo -n rm -rf "${TS_STATE_BACKUP}"
  sudo -n mv "${tmp}" "${TS_STATE_BACKUP}"
  sudo -n chmod 700 "${TS_STATE_BACKUP}"
  sudo -n chown -R root:root "${TS_STATE_BACKUP}"
}

ensure_tailscaled() {
  sudo -n mkdir -p "${TS_STATE_LIVE}" /run/tailscale
  sudo -n chmod 700 "${TS_STATE_LIVE}"
  restore_tailscale_state_if_needed

  if ! pgrep -x tailscaled >/dev/null 2>&1; then
    # Match the existing userspace-networking invocation. Do not use funnel.
    sudo -n nohup "${TS_BIN}" \
      --tun=userspace-networking \
      --state="${TS_STATE_LIVE}/tailscaled.state" \
      --socket="${TS_SOCKET}" \
      >/tmp/tailscaled.log 2>&1 9>&- &
    log "started tailscaled"
    local i
    for i in $(seq 1 50); do
      if [ -S "${TS_SOCKET}" ]; then
        break
      fi
      sleep 0.2
    done
  fi

  local state=""
  local i
  for i in $(seq 1 50); do
    state=$(backend_state)
    case "${state}" in
      Running|NeedsLogin|Stopped) break ;;
    esac
    sleep 0.2
  done

  if [ "${state}" != "Running" ]; then
    # Already-authenticated state should come up without a sign-in. Do not pass --reset.
    if ! timeout 12 tailscale --socket="${TS_SOCKET}" up --hostname=agent-board \
        >/dev/null 2>>"${START_LOG}"; then
      log "tailscale up did not reach Running (state=${state:-unknown}); sign-in may be required"
    fi
    state=$(backend_state)
  fi

  # Restore HTTPS serve on the tailnet hostname. Never use tailscale funnel.
  # Unprivileged `tailscale serve` is denied on this box; use sudo -n.
  if ! sudo -n tailscale --socket="${TS_SOCKET}" serve --bg 8787 >/dev/null 2>>"${START_LOG}"; then
    log "tailscale serve --bg 8787 failed"
  fi

  backup_tailscale_state
}

session_is_supervised() {
  tmux has-session -t "${TMUX_SESSION}" 2>/dev/null || return 1
  tmux list-panes -t "${TMUX_SESSION}" -F '#{pane_start_command}' 2>/dev/null \
    | grep -q 'supervise-board'
}

wait_for_port() {
  local i
  for i in $(seq 1 50); do
    if port_in_use; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

ensure_board() {
  if [ ! -x "${SUPERVISE}" ]; then
    log "missing ${SUPERVISE}"
    return 1
  fi
  if [ ! -d "${BOARD_DIR}" ]; then
    log "missing ${BOARD_DIR}"
    return 1
  fi

  if session_is_supervised; then
    log "board supervisor already running"
    return 0
  fi

  if tmux has-session -t "${TMUX_SESSION}" 2>/dev/null; then
    log "replacing unsupervised tmux session ${TMUX_SESSION}"
    tmux kill-session -t "${TMUX_SESSION}" 2>/dev/null || true
    local i
    for i in $(seq 1 20); do
      if port_in_use; then
        sleep 0.25
      else
        break
      fi
    done
  elif port_in_use; then
    log "port 8787 is already in use outside tmux; not starting a second copy"
    return 1
  fi

  # Close the flock fd so the long-lived tmux server does not inherit it.
  tmux new-session -d -s "${TMUX_SESSION}" "${SUPERVISE}" 9>&-
  log "started board supervisor in tmux session ${TMUX_SESSION}"
  wait_for_port || log "board did not bind 8787 before start script returned"
}

ensure_hooks
ensure_tailscaled
ensure_board
