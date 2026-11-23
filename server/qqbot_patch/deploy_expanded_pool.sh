#!/usr/bin/env bash
set -euo pipefail
stage=/root/qqbot-expanded-stage
engine=/root/qqbot-native-engine
module=/root/.dsh/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib/commands
dll="$engine/v0.111.1/mods/QQBotEnemyTest/QQBotEnemyTest.dll"
backup="/root/backup/expanded-pool-$(date +%Y%m%d-%H%M%S)"
python3 - "$stage" <<'PY'
import hashlib,json,pathlib,re,sys
p=pathlib.Path(sys.argv[1]); proof=json.loads((p/'coverage-summary.json').read_text())
assert proof['passed'] and proof['poolCards']==395 and proof['cardPlayChecks']==934
assert hashlib.sha256((p/'QQBotEnemyTest.dll').read_bytes()).hexdigest()==proof['modelHash']
for name,digest in proof['sourceHashes'].items():assert hashlib.sha256((p/name).read_bytes()).hexdigest()==digest,name
catalog=json.loads((p/'legacy-card-pool.json').read_text())
source=(p/'toys.js').read_text()
jobs={name:json.loads(value) for name,value in re.findall(r'^    (Ironclad|Silent|Regent|Necrobinder|Defect): (\{[^\n]+\}),?$',source,re.M)}
assert catalog==jobs and len(jobs)==5 and all(len(v['pool'])==79 for v in jobs.values())
players=json.loads(pathlib.Path('/root/.dsh/profiles/qqbot/toys_data/players.json').read_text())
for player in players.values():
    for progress in [player,*player.get('jobDecks',{}).values()]:
        job=progress.get('job',player.get('job','Defect'))
        if progress is not player:
            job=next((key for key,val in player.get('jobDecks',{}).items() if val is progress),job)
        if job not in catalog:continue
        allowed=set(catalog[job]['starter']+catalog[job]['pool'])
        assert all(card.removesuffix('+') in allowed for card in progress.get('deck',[])),'Saved deck incompatible'
print('Release hashes, 395-card catalog and saved decks verified')
PY
node --check "$stage/toys.js"
python3 -m py_compile "$stage/duel_record_adapter.py"
mkdir -p "$backup" "$stage/lib/commands" "$stage/lib/features"
chmod 700 "$backup"
for name in toys.js duel_record_adapter.py; do cp "$module/$name" "$backup/$name"; done
cp "$dll" "$backup/QQBotEnemyTest.dll"
cp "$engine/legacy-card-pool.json" "$backup/legacy-card-pool.json"
cp "$engine/worker.py" "$backup/worker.py"
cp /root/.dsh/profiles/qqbot/toys_data/players.json "$backup/players.json.snapshot"
echo "BACKUP=$backup"
changed=0
rollback() {
    trap - ERR
    systemctl stop dsh-qqbot
    if [ "$changed" -eq 1 ]; then
        systemctl stop qqbot-duel-engine
        cp "$backup/QQBotEnemyTest.dll" "$dll"
        cp "$backup/legacy-card-pool.json" "$engine/legacy-card-pool.json"
        for name in toys.js duel_record_adapter.py; do cp "$backup/$name" "$module/$name"; done
        systemctl start qqbot-duel-engine
    fi
    systemctl start dsh-qqbot
    echo "Deployment failed; program files restored from $backup; player data not restored" >&2
}
trap rollback ERR
# Let requests already accepted by the old resident host finish before replacing its DLL.
for attempt in $(seq 1 55); do
    active=$(python3 - "$engine" <<'PY'
import json,pathlib,sys,time
root=pathlib.Path(sys.argv[1]); count=0
for p in root.joinpath('runs').glob('*/host.json'):
    if time.time()-p.stat().st_mtime>180:continue
    host=pathlib.Path(json.loads(p.read_text())['host'])
    if not (host/('done-'+p.parent.name+'.json')).exists() and not p.with_name('resident-result.json').exists():count+=1
print(count)
PY
)
    if [ "$active" -eq 0 ]; then break; fi
    echo "Waiting for $active active duel"
    sleep 2
done
[ "$active" -eq 0 ]
systemctl stop dsh-qqbot
systemctl stop qqbot-duel-engine
changed=1
cp "$stage/QQBotEnemyTest.dll" "$dll"
cp "$stage/legacy-card-pool.json" "$engine/legacy-card-pool.json"
for name in toys.js duel_record_adapter.py; do cp "$stage/$name" "$module/$name"; done
systemctl start qqbot-duel-engine
# Real command handlers and native worker, synthetic saves and captured image only.
for name in toys.js native_duel.js native_duel.config.json render_duel_report.py duel_record_adapter.py; do cp "$module/$name" "$stage/lib/commands/$name"; done
cp "$module/../features/admin-guard.js" "$stage/lib/features/admin-guard.js"
printf '{"type":"module"}\n' > "$stage/package.json"
node "$stage/smoke_expanded_online.mjs" | tee "$stage/deployment-smoke.json"
offset=$(stat -c %s /root/.dsh/qqbot.log)
systemctl start dsh-qqbot
ready=0
for attempt in $(seq 1 20); do
    if tail -c +$((offset+1)) /root/.dsh/qqbot.log | grep -q 'Bot ready'; then ready=1; break; fi
    sleep 2
done
[ "$ready" -eq 1 ]
systemctl is-active dsh-qqbot qqbot-duel-engine
sha256sum "$dll"
trap - ERR
echo 'EXPANDED_POOL_DEPLOYED=395'
