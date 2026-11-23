#!/usr/bin/env bash
set -euo pipefail
stage=/root/qqbot-card-offer-stage
module=/root/.dsh/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib/commands
files='toys.js card_offer_image.js render_card_offer.py card_image_manifest.json'
node --check "$stage/lib/commands/toys.js"
node --check "$stage/lib/commands/card_offer_image.js"
python3 - "$stage" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1])/'lib/commands'
m=json.loads((p/'card_image_manifest.json').read_text())
assert len(m)==828
root=pathlib.Path('/root/qqbot-expanded-stage/wiki-cards')
assert all((root/name).is_file() for name in m.values())
print('828 cached card images verified')
PY
node --experimental-default-type=module "$stage/test_card_offer.mjs" | tee "$stage/card-offer-release-test.json"
node --experimental-default-type=module "$stage/test_deck_image.mjs" | tee "$stage/deck-release-test.json"
backup="/root/backup/card-images-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup";chmod 700 "$backup"
for name in $files; do if [ -f "$module/$name" ]; then cp "$module/$name" "$backup/$name"; fi; done
cp /root/.dsh/profiles/qqbot/toys_data/players.json "$backup/players.json.snapshot"
sha256sum /root/qqbot-native-engine/v0.111.1/mods/QQBotEnemyTest/QQBotEnemyTest.dll > "$backup/engine.sha256"
echo "BACKUP=$backup"
rollback() {
    trap - ERR
    for name in $files; do if [ -f "$backup/$name" ]; then cp "$backup/$name" "$module/$name"; fi; done
    systemctl restart dsh-qqbot
    echo "Program files restored from $backup; player data untouched" >&2
}
trap rollback ERR
for attempt in $(seq 1 50); do
    active=$(python3 - <<'PY'
import json,pathlib,time
n=0
for p in pathlib.Path('/root/qqbot-native-engine/runs').glob('*/host.json'):
    if time.time()-p.stat().st_mtime>180:continue
    host=pathlib.Path(json.loads(p.read_text())['host'])
    if not (host/('done-'+p.parent.name+'.json')).exists() and not p.with_name('resident-result.json').exists():n+=1
print(n)
PY
)
    if [ "$active" -eq 0 ]; then break; fi
    echo 'Waiting for current duel';sleep 2
done
[ "$active" -eq 0 ]
systemctl stop dsh-qqbot
for name in card_offer_image.js render_card_offer.py card_image_manifest.json toys.js; do cp "$stage/lib/commands/$name" "$module/$name"; done
node --check "$module/toys.js"
python3 -m py_compile "$module/render_card_offer.py"
sha256sum -c "$backup/engine.sha256"
for name in $files; do cmp "$stage/lib/commands/$name" "$module/$name"; done
offset=$(stat -c %s /root/.dsh/qqbot.log)
systemctl start dsh-qqbot
ready=0
for attempt in $(seq 1 20); do
    if tail -c +$((offset+1)) /root/.dsh/qqbot.log | grep -q 'Bot ready'; then ready=1;break;fi
    sleep 2
done
[ "$ready" -eq 1 ]
systemctl is-active dsh-qqbot qqbot-duel-engine
trap - ERR
echo 'CARD_IMAGES_DEPLOYED=draw3,deck5,page25'
