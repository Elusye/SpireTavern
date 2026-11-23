#!/usr/bin/env bash
set -euo pipefail
stage=/root/qqbot-native-stage
mkdir -p "$stage/lib/commands" "$stage/lib/features"
for name in toys.js native_duel.js native_duel.config.json render_duel_report.py duel_record_adapter.py card_offer_image.js render_card_offer.py card_image_manifest.json; do
    cp "$stage/$name" "$stage/lib/commands/$name"
done
cp "$stage/admin-guard.js" "$stage/lib/features/admin-guard.js"
printf '{"type":"module"}\n' > "$stage/package.json"
node --check "$stage/lib/commands/toys.js"
node --check "$stage/lib/commands/native_duel.js"
node "$stage/smoke_native_online.mjs" | tee "$stage/smoke-result.txt"
python3 - "$stage" <<'PY'
import collections,json,pathlib,sys
catalog=json.loads((pathlib.Path(sys.argv[1])/'legacy-card-pool.json').read_text())
players=json.loads(pathlib.Path('/root/.dsh/profiles/qqbot/toys_data/players.json').read_text())
jobs=collections.Counter();invalid=collections.Counter();upgraded=0;maximum=0
for p in players.values():
    job=p.get('job','Defect')
    if job not in catalog:job='Defect'
    deck=p.get('deck') or catalog[job]['starter']
    allowed=set(catalog[job]['starter']+catalog[job]['pool'])
    jobs[job]+=1;maximum=max(maximum,len(deck))
    for card in deck:
        upgraded+=card.endswith('+')
        if card.removesuffix('+') not in allowed:invalid[card]+=1
print(json.dumps({'savedPlayers':len(players),'jobs':jobs,'upgradedCards':upgraded,'largestDeck':maximum,'unsupportedCards':invalid}))
PY
systemctl is-active qqbot-duel-engine
systemctl is-active dsh-qqbot
