#!/usr/bin/env bash
# Compatibility entry point. The canonical installer owns workflow migration,
# companion-skill installation, and current setup instructions.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
printf '\033[0;33m🏹 scripts/setup.sh now delegates to scripts/install.sh.\033[0m\n'
exec "$SCRIPT_DIR/install.sh"
