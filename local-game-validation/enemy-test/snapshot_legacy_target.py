"""Retain the 250-card baseline target independently of the expanded live source."""
import json,re
from pathlib import Path
root=Path(__file__).resolve().parents[1]
text=(root/'model-snapshots/toys-before-expansion.js').read_text(encoding='utf-8')
jobs={name:json.loads(value) for name,value in re.findall(r'^    (Ironclad|Silent|Regent|Necrobinder|Defect): (\{[^\n]+\}),?$',text,re.M)}
assert len(jobs)==5 and all(len(j['pool'])==50 for j in jobs.values())
data={'baseCards':269,'derivedCards':['Burn','Dazed','Debris','Shiv','Soul','SovereignBlade','Void','Wound'],'total':277,'jobs':jobs}
(root/'model-snapshots/legacy-card-coverage-target.json').write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
