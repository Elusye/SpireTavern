"""Compare matched baseline/lean runs, including every recorded card/state snapshot."""
import hashlib
import json
import statistics
from pathlib import Path

root = Path(__file__).resolve().parents[1]
def read(p): return json.loads(p.read_text(encoding='utf-8-sig'))
manifest = read(root/'resource-comparison-runs.json')
assert len(manifest) == 8, 'Comparison is still running or failed; expected six independent runs and two 10-match runs'
groups = {name: {'single': [], 'warm': None} for name in ('baseline','lean')}
digests = []
for entry in manifest:
    directory = Path(entry['directory'])
    data = read(directory/'resources.json')
    result = read(directory/'result.json')
    assert result['passed'] and data['ExitCode']==0 and not data['TimedOut'], directory
    assert data['Variant'] == entry['variant']
    log = (directory/'game.log').read_text(encoding='utf-8-sig')
    runtime_errors = [line for line in log.splitlines() if 'Exception:' in line or 'Hand size' in line]
    if entry['variant'] == 'lean':
        assert '[QQBOT_RESOURCES] lean:' in log
    phases = [json.loads(line) for line in (directory/'phases.jsonl').read_text(encoding='utf-8-sig').splitlines()]
    row = dict(directory=str(directory), runtimeErrors=runtime_errors, peakWorkingMiB=data['PeakWorkingBytes']/2**20,
               peakPrivateMiB=data['PeakPrivateBytes']/2**20, seconds=data['EngineSeconds'])
    if entry['repeat']==1:
        groups[entry['variant']]['single'].append(row)
        files = [directory/'alternating-duel.json']
    else:
        assert len(result['runs'])==10 and all(r['passed'] for r in result['runs'])
        row['cleaned'] = [dict(iteration=p['iteration'], workingMiB=p['workingBytes']/2**20, privateMiB=p['privateBytes']/2**20) for p in phases if p['stage']=='match_cleaned']
        row['idle'] = [dict(stage=p['stage'], workingMiB=p['workingBytes']/2**20, privateMiB=p['privateBytes']/2**20) for p in phases if p['stage'] in ('idle_start','idle_end')]
        row['matchSeconds'] = [r['seconds'] for r in result['runs']]
        groups[entry['variant']]['warm'] = row
        files = sorted(directory.glob('match-*/alternating-duel.json'))
    for path in files:
        value = read(path)
        canonical = json.dumps(value,sort_keys=True,separators=(',',':')).encode()
        digests.append(dict(path=str(path),sha256=hashlib.sha256(canonical).hexdigest(),variant=entry['variant']))
assert len(digests)==26
equal = len({d['sha256'] for d in digests})==1
for group in groups.values():
    assert len(group['single'])==3 and group['warm']
    group['singleMedianWorkingMiB'] = statistics.median(r['peakWorkingMiB'] for r in group['single'])
    group['singleMedianPrivateMiB'] = statistics.median(r['peakPrivateMiB'] for r in group['single'])
    group['singleMedianSeconds'] = statistics.median(r['seconds'] for r in group['single'])
reduction = 100*(1-groups['lean']['singleMedianWorkingMiB']/groups['baseline']['singleMedianWorkingMiB'])
stable = not any(row['runtimeErrors'] for group in groups.values() for row in group['single'] + [group['warm']])
summary = dict(exactRecordsEqual=equal,stabilityCheckPassed=stable,recordCount=len(digests),groups=groups,
               singleWorkingReductionPercent=reduction,recordDigests=digests)
(root/'resource-comparison-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
lines = ['显示资源优化对照实验（2026-11-22，本机Windows，0.113.1）',
         '两组相同模组版本、固定牌组、种子和先手，完全静音。交错各测3次独立启动，另各同进程连续10场并空闲15秒。',
         '轻量组跳过批量预加载会话（同时避免卸载在用缓存）、通用VFX及过场淡入淡出；仍创建主菜单/战斗/角色场景，并非纯逻辑引擎。',
         '初版轻量组出现材质已释放异常，原始批次保存在 resource-comparison-initial-diagnostic.json，不计入最终对照；修复后两组均重新运行。', '',
         f'26场完整JSON记录（含每张牌前后HP、格挡、能量、球、状态、抽牌、先后手与胜负）完全一致：{equal}',
         f'运行异常检查通过：{stable}。结果一致不能替代稳定性验证。',
         f'独立启动驻留峰值中位数降低：{reduction:.1f}%', '']
for label,group in groups.items():
    lines += [label,
        f"  独立启动驻留峰值中位数 {group['singleMedianWorkingMiB']:.1f} MiB，私有提交峰值中位数 {group['singleMedianPrivateMiB']:.1f} MiB，总耗时中位数 {group['singleMedianSeconds']:.2f}秒。"]
    for r in group['single']:
        lines.append(f"  单次：驻留峰值{r['peakWorkingMiB']:.1f}MiB，私有峰值{r['peakPrivateMiB']:.1f}MiB，{r['seconds']:.2f}秒。")
        if r['runtimeErrors']: lines.append('  运行异常：'+str(r['runtimeErrors']))
    warm=group['warm']
    lines += [f"  连续10场：驻留峰值{warm['peakWorkingMiB']:.1f}MiB，私有峰值{warm['peakPrivateMiB']:.1f}MiB，总耗时{warm['seconds']:.2f}秒（含15秒空闲）。",
              f"  暖场后每场建局+对战中位数：{statistics.median(warm['matchSeconds'][1:]):.3f}秒。"]
    lines += [f"  第{v['iteration']}场清理后：驻留{v['workingMiB']:.1f}MiB，私有{v['privateMiB']:.1f}MiB" for v in warm['cleaned']]
    lines += [f"  {v['stage']}：驻留{v['workingMiB']:.1f}MiB，私有{v['privateMiB']:.1f}MiB" for v in warm['idle']]
    if warm['runtimeErrors']:
        lines.append(f"  连续运行异常记录{len(warm['runtimeErrors'])}条："+str(sorted(set(warm['runtimeErrors']))))
    lines.append('')
lines += ['限制：主游戏进程口径；100ms采样，驻留全程峰值用系统PeakWorkingSet；私有内存不是实际驻留，不与驻留相加。未计辅助进程和渲染器内存。',
          '未清空系统文件缓存、未施加2核2G限制、不是Linux实测；未验证完整卡池。少量短测不能证明长期内存稳定或排除泄漏。',
          '默认仍为baseline；使用 Test-Enemy.ps1 -ResourceVariant lean 运行轻量组，未部署线上。']
(root/'显示资源对照实验报告.txt').write_text('\n'.join(lines),encoding='utf-8')
print('Exact records equal:',equal,'count:',len(digests),'reduction:',round(reduction,1),'%')
print('Stability check passed:',stable)
for name,g in groups.items():
    print(name,'single MiB',round(g['singleMedianWorkingMiB'],1),'seconds',round(g['singleMedianSeconds'],2),'warm peak MiB',round(g['warm']['peakWorkingMiB'],1),'idle',g['warm']['idle'])
if not equal:
    raise SystemExit('Battle records differ: inspect SHA256 groups before enabling lean mode')
if not stable:
    raise SystemExit('Resource comparison saved; stability check FAILED. Do not treat lean as production-ready.')
