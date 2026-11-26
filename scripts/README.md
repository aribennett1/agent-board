# Box start scripts

These are the versioned copies of the start scripts used on the Grok Bot box.
The live copies that actually run at boot live in `/workspace/agent-board-ops/`
(on the persistent disk, outside this checkout), so a branch change cannot
break startup.

On this box, `start-desktop.sh` is not a full session manager, systemd is
offline, and cron is not installed. The boot hook is a `PATH` wrapper at
`/home/box/.local/bin/xfce4-panel` (plus a non-blocking `~/.bashrc` fallback).
See `/workspace/agent-board-ops/README.md` for paths and box-replacement notes.

`start-box.sh` starts Tailscale in userspace networking if needed, restores
`tailscale serve --bg 8787` (never funnel), and runs the board in tmux session
`agent-board` under a crash-restart loop. It is idempotent.
