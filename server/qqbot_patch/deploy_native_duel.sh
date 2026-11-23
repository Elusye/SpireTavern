#!/usr/bin/env bash
set -euo pipefail
module=/root/.dsh/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib/commands
stage=/root/qqbot-native-stage
backup="/root/backup/native-duel-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup"
chmod 700 "$backup"
cp /root/.dsh/profiles/qqbot/toys_data/players.json "$backup/players.json.snapshot"
for name in toys.js native_duel.js native_duel.config.json render_duel_report.py duel_record_adapter.py; do
    if [ -f "$module/$name" ]; then cp "$module/$name" "$backup/$name"; fi
done
rollback() {
    trap - ERR
    for name in toys.js native_duel.js native_duel.config.json render_duel_report.py duel_record_adapter.py; do
        if [ -f "$backup/$name" ]; then cp "$backup/$name" "$module/$name"; fi
    done
    systemctl restart dsh-qqbot
    printf 'Deployment failed; restored %s\n' "$backup" >&2
}
trap rollback ERR
cp "$stage/toys.js" "$module/toys.js"
cp "$stage/native_duel.js" "$module/native_duel.js"
cp "$stage/render_duel_report.py" "$module/render_duel_report.py"
cp "$stage/duel_record_adapter.py" "$module/duel_record_adapter.py"
cp "$stage/native_duel.config.json" "$module/native_duel.config.json"
node --check "$module/toys.js"
node --check "$module/native_duel.js"
python3 -m py_compile "$module/render_duel_report.py" "$module/duel_record_adapter.py"
printf 'BACKUP=%s\n' "$backup"
offset=$(stat -c %s /root/.dsh/qqbot.log)
systemctl restart dsh-qqbot
ready=0
for attempt in $(seq 1 15); do
    if tail -c +$((offset+1)) /root/.dsh/qqbot.log | grep -q 'Bot ready'; then ready=1; break; fi
    sleep 2
done
[ "$ready" -eq 1 ]
systemctl is-active dsh-qqbot
systemctl is-active qqbot-duel-engine
tail -c +$((offset+1)) /root/.dsh/qqbot.log | grep 'Bot ready' | tail -n 1
trap - ERR
