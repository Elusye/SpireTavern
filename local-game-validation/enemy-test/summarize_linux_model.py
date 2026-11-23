"""Verify only explicit v0.111.1 Linux model evidence, keeping old reports intact."""
import json
from pathlib import Path
import re
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
rows = []
for name in ['vulnerable', 'weak', 'upgrades', 'orbs', 'pvp']:
    paths = sorted((root/'linux-model-runs').glob(f'*-{name}-*-*/result.json'))
    assert paths, name
    path = paths[-1]
    result = json.loads(path.read_text(encoding='utf-8-sig'))
    assert result['gameVersion'] == '0.111.1' and result['passed'], (name, result.get('error'))
    assert result['checks'] and all(c['passed'] for c in result['checks'])
    log = path.with_name('game.log').read_text(encoding='utf-8-sig')
    assert not re.search(r'^(?:ERROR: |\[ERROR\] )System\.[A-Za-z.]*Exception:',log,re.M)
    rows.append({'case':name,'checks':len(result['checks']),'result':str(path)})
duels = sorted((root/'linux-model-runs').glob('**/alternating-duel.json'))
subprocess.run([sys.executable,str(root/'enemy-test/verify_alternating.py'),*[str(p) for p in duels]],check=True)
for path in duels:
    assert path.with_name('report.png').is_file(), path
summary = {'passed':True,'gameVersion':'0.111.1','platform':'Linux',
           'mechanics':rows,'mechanicChecks':sum(r['checks'] for r in rows),
           'duelRecords':len(duels),'imageReports':len(duels),
           'limitations':'Bounded prototype card coverage; not full card/turn/relic certification or production deployment.'}
(root/'linux-model-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(summary,ensure_ascii=False,indent=2))
