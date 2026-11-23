"""Fail closed unless every old pool card and its upgrade has current-build Linux evidence."""
import hashlib
import json
from pathlib import Path
import re
import argparse

root = Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser()
parser.add_argument('--dll',type=Path,default=root/'build-v0.111.1/QQBotEnemyTest.dll')
parser.add_argument('--target',type=Path,default=root/'legacy-card-coverage-target.json')
args=parser.parse_args()
model_hash = hashlib.sha256(args.dll.read_bytes()).hexdigest()
target = json.loads(args.target.read_text(encoding='utf-8'))
runs = []
for path in sorted((root/'linux-model-runs').glob('*/result.json')):
    result = json.loads(path.read_text(encoding='utf-8-sig'))
    if result.get('modelHash') == model_hash:
        runs.append((path,result))

def verify_run(path, result):
    assert result['passed'] and result['gameVersion']=='0.111.1', (path,result.get('error'))
    assert all(c['passed'] for c in result['checks']), path
    assert 'QQBOT_UNIT_EXIT=0' in path.with_name('remote-result.txt').read_text(encoding='utf-8'), path
    log = path.with_name('game.log').read_text(encoding='utf-8-sig')
    assert not re.search(r'^(?:ERROR: |\[ERROR\] )System\.[A-Za-z.]*Exception:',log,re.M), path

rows = []
for job, data in target['jobs'].items():
    candidates = [(p,r) for p,r in runs if r['testCase']=='coverage' and p.with_name('card-coverage.json').is_file()
                  and json.loads(p.with_name('card-coverage.json').read_text(encoding='utf-8'))['job']==job]
    assert candidates, f'Missing current-build coverage for {job}'
    path,result = candidates[-1]
    verify_run(path,result)
    coverage = json.loads(path.with_name('card-coverage.json').read_text(encoding='utf-8'))
    assert coverage['allPassed'] and coverage['modelHash']==model_hash
    expected = set(data['starter']+data['pool']) | {'Silent':{'Shiv'},'Regent':{'SovereignBlade'},'Necrobinder':{'Soul'}}.get(job,set())
    keys = {(r['name'],r['upgrade']) for r in coverage['records'] if r['passed'] and r['playable']}
    assert len(coverage['records'])==len(expected)*2
    assert keys=={(name,upgrade) for name in expected for upgrade in [False,True]}, (job,expected-{n for n,u in keys})
    peak = int(re.search(r'Maximum resident set size \(kbytes\): (\d+)',path.with_name('memory.txt').read_text())[1])
    rows.append({'job':job,'pool':len(data['pool']),'starterDistinct':len(set(data['starter'])),
                 'baseCards':len(set(data['starter']+data['pool'])),'playChecks':len(keys),'peakRssMiB':round(peak/1024,1),
                 'evidence':str(path)})
lifecycle = [(p,r) for p,r in runs if r['testCase']=='lifecycle']
assert lifecycle, 'Missing current-build lifecycle checks'
path,result = lifecycle[-1]
verify_run(path,result)
labels = {c['label'] for c in result['checks']}
for required in ['Plasma adds energy after turn-start reset','Oblivion expires at its applier\'s turn end',
                 'Wound remains unplayable','Burn triggers in unplayed hand','Played Debris exhausts',
                 'PvE victory does not revive the defeated player']:
    assert required in labels, required
lifecycle_path = path
lifecycle_checks = len(result['checks'])
duel_rows = []
for path,result in runs:
    record_path = path.with_name('alternating-duel.json')
    if result['testCase'] != 'duel' or not record_path.is_file():
        continue
    record = json.loads(record_path.read_text(encoding='utf-8'))
    verify_run(path,result)
    assert record['modelHash']==model_hash and record['turns']
    ids=[record['first'],record['rear']]
    for index,turn in enumerate(record['turns']):
        assert turn['actor']==ids[index%2]
        assert all(p['hp']>0 for p in turn.get('start',turn['before']))
        for play in turn['plays']:
            assert all(p['hp']>0 for p in play['before']), 'Played after death'
    final=record['turns'][-1]['after']
    assert any(p['hp']==0 for p in final)
    assert record['winner']==[p['id'] for p in final if p['hp']>0]
    assert path.with_name('report.png').is_file()
    duel_rows.append({'characters':[c['job'] for c in record['characters']],
                      'deckMode':record['deckMode'],'first':record['first'],'turns':len(record['turns']),
                      'winner':record['winner'],'evidence':str(record_path)})
legacy_duels=[r for r in duel_rows if r['deckMode']=='legacy']
assert {r['characters'][0] for r in legacy_duels}==set(target['jobs']), 'Need every class as player 1'
assert {r['characters'][1] for r in legacy_duels}==set(target['jobs']), 'Need every class as player 2'
assert {r['first'] for r in duel_rows if r['deckMode']=='starter'}=={1,2}, 'Need both opening orders'
benchmarks = []
for path in sorted((root/'linux-model-runs').glob('*/result.json')):
    benchmark = json.loads(path.read_text(encoding='utf-8-sig'))
    if not benchmark.get('benchmark') or len(benchmark.get('runs',[])) < 3:
        continue
    records = sorted(path.parent.glob('match-*/alternating-duel.json'))
    if len(records) < 3:
        continue
    if not all(json.loads(p.read_text(encoding='utf-8')).get('modelHash')==model_hash for p in records):
        continue
    assert benchmark['passed'] and all(r['passed'] for r in benchmark['runs'])
    assert 'QQBOT_UNIT_EXIT=0' in path.with_name('remote-result.txt').read_text(encoding='utf-8')
    assert not re.search(r'^(?:ERROR: |\[ERROR\] )System\.[A-Za-z.]*Exception:',path.with_name('game.log').read_text(encoding='utf-8-sig'),re.M)
    assert all(p.with_name('report.png').is_file() for p in records)
    benchmarks.append({'matches':len(records),'evidence':str(path)})
assert benchmarks, 'Need at least three consecutive full-pool matches'
summary = {'passed':True,'gameVersion':'0.111.1','modelHash':model_hash,
           'poolCards':sum(r['pool'] for r in rows),'baseCards':target['baseCards'],
           'derivedAndStatusCards':len(target['derivedCards']),'allowedModels':target['total'],
           'cardPlayChecks':sum(r['playChecks'] for r in rows),'lifecycleChecks':lifecycle_checks,
           'jobs':rows,'lifecycleEvidence':str(lifecycle_path),'duels':duel_rows,'repeatRuns':benchmarks,
           'limits':'Controlled per-card fixtures and following-turn checks do not exhaust every card combination.'}
(root/'legacy-card-coverage-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
lines = ['旧卡池适配验收（0.111.1 Linux）',f'模型 SHA256：{model_hash}',
         f"旧卡池：250张非初始牌 + 19张不同职业初始牌 = {target['baseCards']}张；另含8张衍生/状态牌，共{target['total']}个模型。",'']
for row in rows:
    lines.append(f"{target['jobs'][row['job']]['name']}：抽取池{row['pool']}张，初始不同牌{row['starterDistinct']}张；{row['playChecks']}次本体/升级出牌检查通过；峰值RSS {row['peakRssMiB']}MiB。")
    lines.append('证据：'+row['evidence'])
lines += ['',f"合计{summary['cardPlayChecks']}次逐牌检查、{lifecycle_checks}项生命周期/状态/死亡断言。",
          '生命周期证据：'+str(lifecycle_path),
          f'完整对战及图片：{len(duel_rows)}场；另有同进程连续运行证据：'+', '.join(str(b['matches'])+'场' for b in benchmarks)]
for row in duel_rows:
    lines.append(' / '.join(row['characters'])+f"，{row['deckMode']}牌组，{row['turns']}回合；"+row['evidence'])
lines += ['', '所有本报告采用的批次均为当前DLL版本、退出码0、检查通过，且未发现System.*Exception。',
          '仍有原版headless和退出资源清理告警；逐牌夹具及这些组合对战不能证明所有卡牌组合和长期运行稳定。',
          '无UI选牌使用原版Vakuu选择器按顺序选择；PvP眼部攻击给予虚弱；其余费用、升级、伤害及卡牌效果调用0.111.1原版模型。',
          '线上QQ机器人仍为旧引擎，本次未切换生产服务。']
(root/'旧卡池适配验证报告.txt').write_text('\n'.join(lines),encoding='utf-8')
print(json.dumps(summary,ensure_ascii=False,indent=2))
