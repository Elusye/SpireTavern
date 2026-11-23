import json,re
from pathlib import Path
root=Path(__file__).resolve().parents[1]
source=root/'source-v0.111.1'
audit=json.loads((root/'card-expansion-audit.json').read_text(encoding='utf-8'))
for job,value in audit.items():
    for name in value['candidates']:
        code=(source/'MegaCrit.Sts2.Core.Models.Cards'/f'{name}.cs').read_text(encoding='utf-8')
        for power in re.findall(r'PowerCmd\.Apply<(\w+)>',code):
            path=source/'MegaCrit.Sts2.Core.Models.Powers'/f'{power}.cs'
            if path.exists():code+='\n'+path.read_text(encoding='utf-8')
        tokens=[token for token in ['SavedProperty','GoldReward','GainGold','AddExtraReward','GainMaxHp','MaxHp','DeckVersion','RunState.Deck'] if token in code]
        if tokens:print(job,name,','.join(tokens))
