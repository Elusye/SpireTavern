#!/usr/bin/env bash
set -euo pipefail

PROFILE=${PROFILE:-/root/.dsh/profiles/qqbot}
LIB="$PROFILE/node_modules/@tencent-connect/dsh-qqbot/lib"
SETUP="$LIB/gateway/middleware-setup.js"
MODULE="$LIB/features/log-analysis.js"
BACKUP=$(mktemp "$SETUP.before-log-analysis.XXXXXX")
STAGED=$(mktemp "$SETUP.log-analysis.XXXXXX.mjs")
trap 'rm -f -- "$STAGED"' EXIT
cp -p "$SETUP" "$BACKUP"
node --check "$1"

python3 - "$SETUP" "$STAGED" <<'PY'
from pathlib import Path
import re
import sys

setup, staged = map(Path, sys.argv[1:])
content = setup.read_text(encoding="utf-8")
content = re.sub(r"^    // BEGIN LOG ATTACHMENT PROBE\n.*?^    // END LOG ATTACHMENT PROBE\n",
                 "", content, flags=re.M | re.S)
if 'bot.use(logAnalysis());' not in content:
    anchor = "    // 4. 群历史缓冲"
    if content.count(anchor) != 1:
        raise SystemExit("Cannot locate the post-access-policy hook")
    content = 'import { logAnalysis } from "../features/log-analysis.js";\n' + content
    content = content.replace(anchor, '    bot.use(logAnalysis());\n' + anchor, 1)
staged.write_text(content, encoding="utf-8")
PY
node --check "$STAGED"
if [[ -f "$MODULE" ]]; then
    cp -p "$MODULE" "$BACKUP.module"
fi
cp "$1" "$MODULE"
offset=$(wc -c < /root/.dsh/qqbot.log)
cat "$STAGED" > "$SETUP"
if systemctl restart dsh-qqbot; then
    for attempt in {1..15}; do
        if systemctl is-active --quiet dsh-qqbot &&
            tail -c "+$((offset + 1))" /root/.dsh/qqbot.log | grep -Fq 'Bot ready!'; then
            systemctl is-active dsh-qqbot
            exit 0
        fi
        sleep 2
    done
fi
cp -p "$BACKUP" "$SETUP"
if [[ -f "$BACKUP.module" ]]; then
    cp -p "$BACKUP.module" "$MODULE"
fi
systemctl restart dsh-qqbot
echo "Log analysis did not start. Restored previous middleware." >&2
exit 1
