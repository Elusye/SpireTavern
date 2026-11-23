"""Derive the bounded native model catalogue from the bot's actual five job pools."""
import argparse
import json
from pathlib import Path
import re

parser = argparse.ArgumentParser()
parser.add_argument('--check', action='store_true')
parser.add_argument('--expanded', action='store_true', help='Build the complete 150-card candidate catalog for isolated validation')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
text = (root.parent/'server/qqbot_patch/toys.js').read_text(encoding='utf-8')
jobs = {name:json.loads(value) for name,value in re.findall(
    r'^    (Ironclad|Silent|Regent|Necrobinder|Defect): (\{[^\n]+\}),?$',text,re.M)}
excluded=json.loads((root/'card-expansion-policy.json').read_text(encoding='utf-8'))['excluded']
assert len(jobs)==5 and all(len(job['pool']) in (50,79,80) for job in jobs.values())
if args.expanded:
    audit=json.loads((root/'card-expansion-audit.json').read_text(encoding='utf-8'))
    for name,job in jobs.items():
        job['pool']=[card for card in dict.fromkeys(job['pool']+audit[name]['candidates']) if card not in excluded]
        assert len(job['pool'])==79
source = root/'source-v0.111.1/MegaCrit.Sts2.Core.Models.Cards'
base = {c for job in jobs.values() for c in job['starter']+job['pool']}
colorless_code=(root/'source-v0.111.1/MegaCrit.Sts2.Core.Models.CardPools/ColorlessCardPool.cs').read_text(encoding='utf-8')
generated=set()
for card in re.findall(r'ModelDb.Card<(\w+)>',colorless_code):
    code=(source/(card+'.cs')).read_text(encoding='utf-8')
    if card not in excluded and 'CardMultiplayerConstraint.MultiplayerOnly' not in code and 'CanBeGeneratedInCombat => false' not in code:
        generated.add(card)
all_cards = base | generated
pending = list(all_cards)
power_source=root/'source-v0.111.1/MegaCrit.Sts2.Core.Models.Powers'
def with_powers(code,seen=None):
    seen=set() if seen is None else seen
    for name in re.findall(r'<(\w+)>|new (\w+)\(',code):
        name=next((part for part in name if part),'')
        path=power_source/(name+'.cs')
        if name not in seen and path.exists():
            seen.add(name)
            code+='\n'+with_powers(path.read_text(encoding='utf-8'),seen)
    return code
while pending:
    name = pending.pop()
    code = with_powers((source/(name+'.cs')).read_text(encoding='utf-8'))
    refs = {part for pair in re.findall(r'<(\w+)>|new (\w+)\(',code) for part in pair
            if part and (source/(part+'.cs')).exists()}
    for ref in refs-all_cards:
        all_cards.add(ref)
        pending.append(ref)
lines = ['using MegaCrit.Sts2.Core.Models;','using MegaCrit.Sts2.Core.Models.Cards;',
         'namespace QQBotEnemyTest;','internal static class LegacyCardCatalog {',
         'internal static readonly Dictionary<string,string[]> Jobs = new() {']
for name,job in jobs.items():
    lines.append('["'+name+'"] = new[] { '+', '.join('"'+c+'"' for c in dict.fromkeys(job['starter']+job['pool']))+' },')
lines += ['};','internal static readonly string[] Generated = new[] { '+', '.join('"'+c+'"' for c in sorted(generated))+' };', 'internal static readonly HashSet<string> Allowed = new() {']
for name in sorted(all_cards):
    qualified = 'MegaCrit.Sts2.Core.Models.Cards.'+name if name in {'Buffer','Void'} else name
    lines.append('ModelDb.Card<'+qualified+'>().Id.Entry,')
lines += ['};','internal static CardModel Canonical(string name) => ModelDb.GetById<CardModel>(ModelDb.GetId(typeof(CardModel).Assembly.GetType("MegaCrit.Sts2.Core.Models.Cards." + name, true)!));','}']
catalog = '\n'.join(lines)
path = root/'enemy-test/LegacyCardCatalog.cs'
if args.check:
    assert path.read_text(encoding='utf-8') == catalog, 'Catalogue differs from current bot pool/source dependencies'
else:
    path.write_text(catalog,encoding='utf-8')
    (root/'legacy-card-pool.json').write_text(json.dumps(jobs,ensure_ascii=False,indent=2),encoding='utf-8')
    (root/'legacy-card-coverage-target.json').write_text(json.dumps({
        'baseCards':len(base),'generatedColorlessCards':sorted(generated),'derivedCards':sorted(all_cards-base-generated),'total':len(all_cards),'jobs':jobs
    },ensure_ascii=False,indent=2),encoding='utf-8')
print(f'{len(base)} legacy starter/pool cards + {len(all_cards-base)} dependencies = {len(all_cards)} native models')
