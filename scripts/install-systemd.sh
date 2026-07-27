#!/usr/bin/env bash
# Instala y activa las unidades systemd (correr como root en sinope).
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
cp "$HERE"/systemd/mindwtr-bridge.service "$HERE"/systemd/mindwtr-bridge.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now mindwtr-bridge.timer
systemctl list-timers mindwtr-bridge.timer --no-pager
