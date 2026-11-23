"""Validate the lazy-resource lifetime repair against native logs and baseline game records."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
def read(p): return json.loads(p.read_text(encoding='utf-8-sig'))
manifest = read(root/'lean-fix-runs.json')
assert len(manifest)==2, 'Repair validation is still running'
warm = Path(next(e['directory'] for e in manifest if e['variant']=='lean'))
baseline = Path(next(e['directory'] for e in manifest if e['variant']=='baseline'))
golden = read(baseline/'alternating-duel.json')
for directory in (warm,baseline):
    result = read(directory/'result.json')
    resource = read(directory/'resources.json')
    assert result['passed'] and resource['ExitCode']==0 and not resource['TimedOut']
    log = (directory/'game.log').read_text(encoding='utf-8-sig')
    assert 'Exception:' not in log and 'Hand size' not in log, directory
    assert 'Handle is not initialized' not in log and 'ObjectDisposedException' not in log
files = sorted(warm.glob('match-*/alternating-duel.json'))
assert len(files)==20
for path in files:
    assert read(path)==golden, f'Battle output differs: {path}'
    assert read(path.with_name('result.json'))['passed']
phases = [json.loads(s) for s in (warm/'phases.jsonl').read_text(encoding='utf-8-sig').splitlines()]
cleaned = [dict(iteration=p['iteration'], cachedAssets=p['cachedAssets'],
                workingMiB=p['workingBytes']/2**20, privateMiB=p['privateBytes']/2**20)
           for p in phases if p['stage']=='match_cleaned']
assert len(cleaned)==20
tail = [p['cachedAssets'] for p in cleaned[5:]]
assert len(set(tail))==1, 'Lazy cache still grows after warmup; investigate before certifying repair'
idle = [dict(stage=p['stage'],workingMiB=p['workingBytes']/2**20,privateMiB=p['privateBytes']/2**20)
        for p in phases if p['stage'] in ('idle_start','idle_end')]
resource=read(warm/'resources.json')
summary=dict(runtimeExceptionCheckPassed=True,baselineRegressionPassed=True,matchingBattleRecords=21,
    peakWorkingMiB=resource['PeakWorkingBytes']/2**20,peakPrivateMiB=resource['PeakPrivateBytes']/2**20,
    cleaned=cleaned,idle=idle,warmDirectory=str(warm),baselineDirectory=str(baseline))
(root/'lean-fix-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
lines=['轻量版对象句柄异常修复验证（2026-11-22）',
       '异常发生在 AssetCache.LoadAsset / PackedScene.Instantiate，切换房间或返回主菜单后的场景资源重新加载路径。',
       '修复：保留已实际使用的按需资源缓存直到引擎退出；仍不批量预加载完整游戏资源。房间节点继续按原版流程清理。',
       '未屏蔽异常或更改Godot句柄桥接；测试启动器现在将日志中的.NET运行异常判为失败。',
       '', '同进程连续20场加15秒空闲，以及独立基准版1场，全部成功。日志无.NET运行异常，21场完整战斗记录一致。',
       f"轻量连续测试：驻留峰值{summary['peakWorkingMiB']:.1f}MiB，私有提交峰值{summary['peakPrivateMiB']:.1f}MiB。",'']
for p in cleaned:
    lines.append(f"清理第{p['iteration']}场后：缓存{p['cachedAssets']}项，驻留{p['workingMiB']:.1f}MiB，私有{p['privateMiB']:.1f}MiB")
for p in idle:
    lines.append(f"{p['stage']}：驻留{p['workingMiB']:.1f}MiB，私有{p['privateMiB']:.1f}MiB")
lines += ['', '边界：这证明当前固定牌组复现场景中的句柄异常已消除，不证明全卡池或长期运行稳定。',
          '不同牌组会加载新的按需资源；70等缓存项数只属于本次测试，不是全卡池上限。',
          '原版退出资源清理告警可能仍存在；未把这些告警视为已修复。Windows实测，不代表Linux服务器内存；未部署线上。',
          str(warm),str(baseline)]
(root/'轻量版异常修复报告.txt').write_text('\n'.join(lines),encoding='utf-8')
print('PASS: no runtime exceptions, 21 identical battle records, warm cache stable')
print('Peak MiB:',round(summary['peakWorkingMiB'],1),'cache:',sorted(set(p['cachedAssets'] for p in cleaned)))
print('Idle:',idle)
