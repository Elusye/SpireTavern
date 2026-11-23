#!/usr/bin/env bash
set -euo pipefail

PROFILE=${PROFILE:-/root/.dsh/profiles/qqbot}
LIB="$PROFILE/node_modules/@tencent-connect/dsh-qqbot/lib"
SETUP="$LIB/gateway/middleware-setup.js"
TOYS="$LIB/commands/toys.js"
LOG=/root/.dsh/qqbot.log
STAGED=$(mktemp "$SETUP.clock.XXXXXX.mjs")
trap 'rm -f -- "$STAGED"' EXIT
node --input-type=module --check < "$1"

python3 - "$SETUP" "$STAGED" <<'PY'
from pathlib import Path
import sys

setup, staged = map(Path, sys.argv[1:])
source = setup.read_text(encoding="utf-8")
hook = "    startDailyClock(bot, logger);"
if hook not in source:
    anchor = "export function setupMiddlewares(bot, config, manager, logger) {"
    if source.count(anchor) != 1:
        raise SystemExit("Cannot find middleware setup")
    source = 'import { startDailyClock } from "../commands/toys.js";\n' + source
    source = source.replace(anchor, anchor + "\n" + hook, 1)
staged.write_text(source, encoding="utf-8")
PY
node --check "$STAGED"

backup=$(mktemp "$SETUP.before-clock.XXXXXX")
cp -p "$SETUP" "$backup"
cp -p "$TOYS" "$backup.toys"
offset=$(wc -c < "$LOG")
rollback() {
    cp -p "$backup" "$SETUP"
    cp -p "$backup.toys" "$TOYS"
    systemctl restart dsh-qqbot
}
trap 'rollback; rm -f -- "$STAGED"' EXIT
cp "$1" "$TOYS"
cat "$STAGED" > "$SETUP"
systemctl restart dsh-qqbot
for attempt in {1..15}; do
    if systemctl is-active --quiet dsh-qqbot &&
        tail -c "+$((offset + 1))" "$LOG" | grep -Fq 'Bot ready!'; then
        trap 'rm -f -- "$STAGED"' EXIT
        echo 'Bot ready after restart'
        exit 0
    fi
    sleep 2
done
exit 1
