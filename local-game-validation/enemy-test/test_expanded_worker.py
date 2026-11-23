"""Exercise the real Python bridge validator with the expanded catalog, no game/socket."""
import json,os,runpy,shutil,tempfile
from pathlib import Path
root=Path(__file__).resolve().parents[1]
audit=json.loads((root/'card-expansion-audit.json').read_text(encoding='utf-8'))
excluded=json.loads((root/'card-expansion-policy.json').read_text(encoding='utf-8'))['excluded']
with tempfile.TemporaryDirectory(prefix='qqbot-catalog-') as temp:
    stage=Path(temp)
    game=stage/'v0.111.1'
    mod=game/'mods/QQBotEnemyTest'
    mod.mkdir(parents=True)
    shutil.copyfile(root/'build-v0.111.1/QQBotEnemyTest.dll',mod/'QQBotEnemyTest.dll')
    shutil.copyfile(root/'legacy-card-pool.json',stage/'legacy-card-pool.json')
    os.environ['QQBOT_ENGINE_ROOT']=str(game)
    worker=runpy.run_path(str(root.parent/'server/qqbot_patch/native_engine_worker.py'),run_name='validator_test')
    validate=worker['validate']
    count=0
    for job,data in audit.items():
        for name in data['candidates']:
            for suffix in ['', '+']:
                request={'seed':'CatalogValidation','players':[{'job':job,'deck':[name+suffix]},
                    {'job':'Ironclad','deck':['StrikeIronclad']}]}
                if name in excluded:
                    try:validate(request)
                    except ValueError:pass
                    else:raise AssertionError('Excluded card accepted: '+name)
                else:
                    validate(request)
                    count+=1
    result={'passed':True,'acceptedNewBaseAndUpgradeDecks':count,'excludedBaseAndUpgradeDecks':10,
            'modelHash':worker['MODEL_HASH']}
    (root/'expanded-worker-validation.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(result))
