"""Accept only current-DLL, successful Linux evidence for the expanded pool."""
import hashlib,json,re,sys
from pathlib import Path

root=Path(__file__).resolve().parents[1]
model_hash=hashlib.sha256((root/'build-v0.111.1/QQBotEnemyTest.dll').read_bytes()).hexdigest()
target=json.loads((root/'legacy-card-coverage-target.json').read_text(encoding='utf-8'))
audit=json.loads((root/'card-expansion-audit.json').read_text(encoding='utf-8'))
policy=json.loads((root/'card-expansion-policy.json').read_text(encoding='utf-8'))['excluded']
metadata_paths=sorted((root/'linux-model-runs').glob('*/native-card-metadata.json'))
metadata=json.loads(metadata_paths[-1].read_text(encoding='utf-8'))['cards']
sys.path.insert(0,str(root.parent/'server/qqbot_patch'))
from duel_record_adapter import card_names
labels=card_names()
assert all(labels.get(card['id'])==card['title'] for name,card in metadata.items() if not name.endswith('+'))

def checked(directory):
    result=json.loads((directory/'result.json').read_text(encoding='utf-8-sig'))
    assert result['passed'] and result['gameVersion']=='0.111.1'
    assert result['modelHash']==model_hash
    assert all(v['passed'] for v in result['checks'])
    owner=directory if (directory/'remote-result.txt').exists() else directory.parent
    assert 'QQBOT_UNIT_EXIT=0' in (owner/'remote-result.txt').read_text(encoding='utf-8')
    assert not re.search(r'^(?:ERROR: |\[ERROR\] )System\.[A-Za-z.]*Exception:',(owner/'game.log').read_text(encoding='utf-8-sig'),re.M)
    return result

def current(directory):
    try:
        value=json.loads((directory/'result.json').read_text(encoding='utf-8-sig'))
        return value.get('passed') is True and value.get('modelHash')==model_hash
    except (OSError,ValueError):return False

runs=[p.parent for p in sorted((root/'linux-model-runs').glob('*/result.json')) if current(p.parent)]
rows=[]
for job,data in target['jobs'].items():
    assert len(data['pool'])==79
    candidates=[name for name in audit[job]['candidates'] if name not in policy]
    assert len(candidates)==29 and set(candidates)<=set(data['pool'])
    assert not set(data['pool'])&set(policy)
    expected=set(data['starter']+data['pool'])|{'Silent':{'Shiv'},'Regent':{'SovereignBlade'},'Necrobinder':{'Soul'}}.get(job,set())
    found=[]
    for directory in runs:
        path=directory/'card-coverage.json'
        if not path.exists():continue
        coverage=json.loads(path.read_text(encoding='utf-8'))
        if coverage['job']!=job:continue
        keys={(r['name'],r['upgrade']) for r in coverage['records'] if r['passed'] and r['playable']}
        if coverage['allPassed'] and keys=={(name,up) for name in expected for up in (False,True)}:
            checked(directory);found.append(directory)
    assert found,f'Missing complete final-build coverage: {job}'
    directory=found[-1]
    peak=int(re.search(r'Maximum resident set size \(kbytes\): (\d+)',(directory/'memory.txt').read_text())[1])/1024
    rows.append({'job':job,'pool':79,'newCards':candidates,'playChecks':len(expected)*2,'peakRssMiB':round(peak,1),'evidence':str(directory)})

generated=[]
for directory in runs:
    path=directory/'card-coverage.json'
    if not path.exists():continue
    coverage=json.loads(path.read_text(encoding='utf-8'))
    if coverage['job']!='Generated':continue
    keys={(r['name'],r['upgrade']) for r in coverage['records'] if r['passed'] and r['playable']}
    if coverage['allPassed'] and keys=={(name,up) for name in target['generatedColorlessCards'] for up in (False,True)}:
        checked(directory);generated.append(directory)
assert generated,'Missing generated-colorless card coverage'
phases={}
for case in ['lifecycle','expansion']:
    candidates=[p for p in runs if checked(p)['testCase']==case]
    assert candidates,f'Missing {case} checks'
    phases[case]={'checks':len(checked(candidates[-1])['checks']),'evidence':str(candidates[-1])}

duels=[]
for path in sorted((root/'linux-model-runs').glob('**/alternating-duel.json')):
    record=json.loads(path.read_text(encoding='utf-8'))
    if record.get('modelHash')!=model_hash:continue
    checked(path.parent)
    alive=[v['id'] for v in record['turns'][-1]['after'] if v['hp']>0]
    assert len(alive)<=1 and set(alive)==set(record['winner'])
    assert path.with_name('report.png').exists()
    duels.append({'jobs':[c['job'] for c in record['characters']],'turns':len(record['turns']),'evidence':str(path)})
assert len(duels)>=5 and set(c for d in duels for c in d['jobs'])==set(target['jobs'])
repeat=[p for p in sorted((root/'linux-model-runs').glob('*/result.json')) if
        len([d for d in duels if str(p.parent) in d['evidence']])>=3]
assert repeat,'Missing consecutive same-process matches'
worker=json.loads((root/'expanded-worker-validation.json').read_text(encoding='utf-8'))
assert worker['passed'] and worker['modelHash']==model_hash and worker['acceptedNewBaseAndUpgradeDecks']==290

summary={'passed':True,'gameVersion':'0.111.1','modelHash':model_hash,'addedCards':145,'poolCards':395,
         'jobs':rows,'generatedColorlessCards':len(target['generatedColorlessCards']),
         'generatedChecks':len(target['generatedColorlessCards'])*2,'generatedEvidence':str(generated[-1]),
         'cardPlayChecks':sum(v['playChecks'] for v in rows)+len(target['generatedColorlessCards'])*2,
         'allowedModels':target['total'],'phaseChecks':phases,'duels':duels,
         'workerValidation':worker,'sourceHashes':{name:hashlib.sha256((root.parent/'server/qqbot_patch'/name).read_bytes()).hexdigest() for name in ['toys.js','duel_record_adapter.py']},
         'excluded':{metadata[n]['title']:reason for n,reason in policy.items()},
         'limits':'逐牌夹具和这些组合对战未穷尽所有分支及组合，不能证明长期运行稳定；生产版本未更换。'}
(root/'expanded-card-coverage-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
lines=['五职业扩展卡池验收（0.111.1 Linux）',f'模型 SHA256：{model_hash}',
       f'新增145张；五职业各79张非初始牌，合计395张。原版初始牌另计。',
       '不加入永久成长/战后收益牌；排除名单：'+ '、'.join(summary['excluded']),
       f"逐牌基础/升级检查{summary['cardPlayChecks']}次；生成无色牌{summary['generatedColorlessCards']}种；对战及图片{len(duels)}场。",'']
for row in rows:
    lines.append(target['jobs'][row['job']]['name']+'新增29张：'+'、'.join(metadata[n]['title'] for n in row['newCards']))
    lines.append(f"逐牌检查{row['playChecks']}次；峰值RSS {row['peakRssMiB']}MiB；证据：{row['evidence']}")
lines+=['','不含多人专属牌和先古牌。生成的无色牌只用于战斗，不进入日常抽卡池。',
        '牌名、费用和升级说明由0.111.1原版运行时导出；伤害及技能仍走原版模型。',
        summary['limits'],'本次只修改本地源码并运行隔离测试，尚未部署。']
(root/'五职业扩展卡池验证报告.txt').write_text('\n'.join(lines),encoding='utf-8')
print(json.dumps({'passed':True,'modelHash':model_hash,'cardPlayChecks':summary['cardPlayChecks'],'duels':len(duels),'phases':phases},ensure_ascii=False))
