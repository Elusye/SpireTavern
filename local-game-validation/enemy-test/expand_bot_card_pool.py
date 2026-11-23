"""Synchronize playable card labels/costs/upgrades with the native 0.111.1 export."""
import argparse
import json
from pathlib import Path
import re

parser=argparse.ArgumentParser()
parser.add_argument('metadata',type=Path)
args=parser.parse_args()
root=Path(__file__).resolve().parents[1]
export=json.loads(args.metadata.read_text(encoding='utf-8-sig'))
assert export['gameVersion']=='0.111.1'
metadata=export['cards']
audit=json.loads((root/'card-expansion-audit.json').read_text(encoding='utf-8'))
excluded=json.loads((root/'card-expansion-policy.json').read_text(encoding='utf-8'))['excluded']
path=root.parent/'server/qqbot_patch/toys.js'
text=path.read_text(encoding='utf-8')
def update_job(match):
    name,value=match.groups()
    job=json.loads(value)
    job['pool']=[card for card in dict.fromkeys(job['pool']+audit[name]['candidates']) if card not in excluded]
    assert len(job['pool'])==79
    for card in job['starter']+job['pool']:
        assert card in metadata and card+'+' in metadata,card
        assert metadata[card]['rarity']!='Ancient'
    return f'    {name}: '+json.dumps(job,ensure_ascii=False)+','
text=re.sub(r'^    (Ironclad|Silent|Regent|Necrobinder|Defect): (\{[^\n]+\}),?$',update_job,text,flags=re.M)
def row(name,card):
    description=card['description']
    for icon,label in [('star_icon','星星'),('ironclad_energy_icon','能量')]:
        token='[img]res://images/packed/sprite_fonts/'+icon+'.png[/img]'
        description=re.sub('(?:'+re.escape(token)+')+',lambda m:str(m[0].count(token))+'点'+label,description)
    description=re.sub(r'\[(?:/?[A-Za-z_]+|/?[A-Za-z_]+=[^\]]+)\]','',description)
    description=re.sub(r'\s+',' ',description).strip()
    # The legacy view uses numeric energy. X is represented with -1, as before.
    source=(root/'source-v0.111.1/MegaCrit.Sts2.Core.Models.Cards'/(name.removesuffix('+')+'.cs')).read_text(encoding='utf-8')
    stars=-1 if 'HasStarCostX => true' in source else max(0,card['stars'])
    return [card['title'],-1 if card['costsX'] else card['cost'],card['type'],description,stars]
base=['    '+name+': '+json.dumps(row(name,card),ensure_ascii=False)+',' for name,card in metadata.items() if not name.endswith('+')]
text=re.sub(r'const GAME_CARDS = \{.*?\n\};','const GAME_CARDS = {\n'+'\n'.join(base)+'\n};',text,count=1,flags=re.S)
upgrades={name:row(name,card) for name,card in metadata.items() if name.endswith('+')}
block='// BEGIN NATIVE 0.111.1 UPGRADED CARD DISPLAY\nObject.assign(GAME_CARDS, '+json.dumps(upgrades,ensure_ascii=False,indent=2)+');\n// END NATIVE 0.111.1 UPGRADED CARD DISPLAY\n'
text=re.sub(r'// BEGIN NATIVE 0.111.1 UPGRADED CARD DISPLAY.*?// END NATIVE 0.111.1 UPGRADED CARD DISPLAY\n','',text,flags=re.S)
text=text.replace('const DUEL_STARTING_HP =',block+'\nconst DUEL_STARTING_HP =',1)
path.write_text(text,encoding='utf-8')
print('Five pools: 79 each; native base metadata:',len(base),'upgrades:',len(upgrades))
