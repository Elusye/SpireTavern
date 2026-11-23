"""Inventory original five-class pools and dependent card models; no static 'supported' inference."""
import json
import re
from pathlib import Path
from collections import Counter

base = Path('E:/games/杀戮尖塔2/0.113.1源代码/MegaCrit/Sts2/Core/Models')
out = Path(__file__).resolve().parents[1]
cards = {p.stem: p for p in (base / 'Cards').glob('*.cs')}
owners = {}
for job in ['Ironclad', 'Silent', 'Regent', 'Necrobinder', 'Defect']:
    text = (base / 'CardPools' / f'{job}CardPool.cs').read_text(encoding='utf-8-sig')
    for name in set(re.findall(r'ModelDb\.Card<([\w]+)>', text)):
        owners.setdefault(name, set()).add(job)
pending = list(owners)
seen = set()
while pending:
    name = pending.pop()
    if name in seen or name not in cards:
        continue
    seen.add(name)
    text = cards[name].read_text(encoding='utf-8-sig')
    refs = set(re.findall(r'(?:ModelDb\.Card|CreateCard|CreateInCombat)<([\w]+)>', text))
    refs |= set(re.findall(r'\b(\w+)\.\w+', text))
    refs |= set(re.findall(r'new\s+(\w+)\s*\(', text))
    for ref in refs & cards.keys():
        if ref not in owners:
            owners[ref] = {'Derived'}
        pending.append(ref)

adapter = (out / 'enemy-test/DuelPrototype.cs').read_text(encoding='utf-8')
whitelist_text = adapter.split('private static readonly HashSet<string> supported')[1].split('};')[0]
allowed = set(re.findall(r'"([A-Z_]+)"', whitelist_text))
rows = []
for name in sorted(owners):
    text = cards[name].read_text(encoding='utf-8-sig')
    identifier = re.sub(r'(?<=[a-z0-9])(?=[A-Z])', '_', name).upper()
    excluded = 'CardMultiplayerConstraint.MultiplayerOnly' in text
    calls = sorted(set(re.findall(r'\b(\w+Cmd)\.(\w+)', text)))
    powers = sorted(set(re.findall(r'PowerCmd\.Apply<([\w]+)>', text)))
    hooks = sorted(set(re.findall(r'override\s+(?:async\s+)?\w+(?:<[^>]+>)?\s+((?:After|Before|Modify|Should)\w+)\(', text)))
    risks = []
    for token, label in [('CardSelectCmd', 'player_selection'), ('CreatureCmd.Damage', 'direct_hp_or_damage'),
        ('Heal', 'healing'), ('Osty', 'osty'), ('SovereignBlade', 'sovereign_blade'), ('Doom', 'doom'),
        ('Forge', 'forge'), ('EnergyCost', 'dynamic_cost'), ('Exhaust', 'exhaust'), ('Channel', 'orbs')]:
        if token in text: risks.append(label)
    if hooks: risks.append('lifecycle_hooks')
    if powers: risks.append('powers')
    rows.append(dict(name=name, id=identifier, owners=sorted(owners[name]),
        status='excluded_multiplayer' if excluded else 'enabled_bounded_adapter' if identifier in allowed else 'not_adapted',
        risks=risks, commands=['.'.join(c) for c in calls], powers=powers, lifecycleHooks=hooks,
        source=str(cards[name])))
result = {'version':'0.113.1','note':'Static inventory only. Enabled does not mean all interactions or upgrades verified. Derived discovery follows explicit references and can miss dynamic factories.',
          'counts':dict(Counter(row['status'] for row in rows)), 'cards':rows}
(out / 'card-pool-coverage.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
lines = ['五职业卡池覆盖清单（0.113.1）', result['note'], str(result['counts']), '']
for job in ['Ironclad','Silent','Regent','Necrobinder','Defect','Derived']:
    group = [row for row in rows if job in row['owners']]
    lines.append(f'{job}: {len(group)} models; '+str(dict(Counter(row['status'] for row in group))))
    lines += [f"  {r['name']}: {r['status']} / {','.join(r['risks'])}" for r in group]
(out / '卡池适配清单.txt').write_text('\n'.join(lines),encoding='utf-8')
print(json.dumps({'models':len(rows),'counts':result['counts']},ensure_ascii=False))
