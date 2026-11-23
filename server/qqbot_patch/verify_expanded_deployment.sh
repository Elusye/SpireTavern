#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
import hashlib,json,pathlib,re
stage=pathlib.Path('/root/qqbot-expanded-stage')
engine=pathlib.Path('/root/qqbot-native-engine')
module=pathlib.Path('/root/.dsh/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib/commands')
proof=json.loads((stage/'coverage-summary.json').read_text())
for name,digest in proof['sourceHashes'].items():assert hashlib.sha256((module/name).read_bytes()).hexdigest()==digest,name
assert hashlib.sha256((engine/'v0.111.1/mods/QQBotEnemyTest/QQBotEnemyTest.dll').read_bytes()).hexdigest()==proof['modelHash']
catalog=json.loads((engine/'legacy-card-pool.json').read_text())
assert all(len(v['pool'])==79 for v in catalog.values())
smoke=json.loads((stage/'deployment-smoke.json').read_text())
assert smoke['passed']
record=json.loads((stage/'new-card-record.json').read_text())
new={'RUPTURE','INFERNAL_BLADE','WHITE_NOISE','ECHO_FORM'}
played={p['card'] for t in record['turns'] for p in t['plays']}
new_played=sorted(c for c in played if c.removesuffix('+') in new)
assert new_played,'New-card execution evidence missing'
assert record['modelHash']==proof['modelHash']
assert json.loads((engine/'speed.json').read_text())['resident'] is True
result={'passed':True,'modelHash':proof['modelHash'],'pools':{k:len(v['pool']) for k,v in catalog.items()},
        'resident':True,'newCardsPlayed':new_played,'turns':len(record['turns']),'smoke':smoke}
(stage/'release-verified.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
print(json.dumps(result,ensure_ascii=False))
PY
systemctl is-active dsh-qqbot qqbot-duel-engine
