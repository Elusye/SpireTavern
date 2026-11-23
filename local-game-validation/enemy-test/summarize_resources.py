"""Summarize measured engine process resources, keeping repeated-process and fresh-launch data separate."""
import csv
import json
import statistics
from datetime import datetime
from pathlib import Path

root = Path(__file__).resolve().parents[1]
MIB = 1024 ** 2
def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))
def dt(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))
def median(values):
    return statistics.median(values) if values else None

records = []
for directory in sorted((root / 'enemy-runs').glob('*-duel')):
    if (directory / 'ABORTED.txt').exists() or not (directory / 'resources.json').exists():
        continue
    resource = read(directory / 'resources.json')
    result = read(directory / 'result.json')
    assert result['passed'] and resource['ExitCode'] == 0 and not resource['TimedOut'], directory
    phases = [json.loads(s) for s in (directory / 'phases.jsonl').read_text(encoding='utf-8-sig').splitlines()]
    start = [p for p in phases if p['stage'] == 'duel_start']
    end = [p for p in phases if p['stage'] == 'duel_end']
    assert len(start) == len(end) == resource['Repeat'], directory
    durations = [(dt(b['utc']) - dt(a['utc'])).total_seconds() for a, b in zip(start, end)]
    cleaned = [dict(iteration=p['iteration'], workingMiB=p['workingBytes']/MIB,
                    privateMiB=p['privateBytes']/MIB, managedMiB=p['managedBytes']/MIB)
               for p in phases if p['stage'] == 'match_cleaned']
    row = dict(directory=str(directory), repeat=resource['Repeat'], engineSeconds=resource['EngineSeconds'],
               peakWorkingMiB=resource['PeakWorkingBytes']/MIB, peakPrivateMiB=resource['PeakPrivateBytes']/MIB,
               cpuSeconds=resource['CpuSeconds'], battleSeconds=durations, cleaned=cleaned)
    menu = next(p for p in phases if p['stage'] == 'main_menu_ready')
    row['menuWorkingMiB'] = menu['workingBytes']/MIB
    if 'processStartUtc' in menu:
        process_start = dt(menu['processStartUtc'])
        startup_seconds = (dt(menu['utc']) - process_start).total_seconds()
        row['startupSeconds'] = startup_seconds
        samples = list(csv.DictReader((directory/'resource-samples.csv').open(encoding='utf-8-sig')))
        def peaks(a,b):
            selected = [s for s in samples if a <= float(s['Seconds']) <= b]
            return dict(workingMiB=max(float(s['WorkingBytes']) for s in selected)/MIB,
                        privateMiB=max(float(s['PrivateBytes']) for s in selected)/MIB) if selected else None
        row['startupSamplePeak'] = peaks(0,startup_seconds)
        intervals = [((dt(a['utc'])-process_start).total_seconds(),(dt(b['utc'])-process_start).total_seconds()) for a,b in zip(start,end)]
        row['battleSamplePeaks'] = [peaks(a,b) for a,b in intervals]
    if (directory/'render-resources.json').exists():
        row.update(read(directory/'render-resources.json'))
    if resource['Repeat'] > 1:
        assert len(result['runs']) == resource['Repeat'] and all(r['passed'] for r in result['runs'])
        row['matchSeconds'] = [r['seconds'] for r in result['runs']]
    idle = [p for p in phases if p['stage'] in ('idle_start','idle_end')]
    if idle:
        assert len(idle) == 2
        row['idle'] = [dict(stage=p['stage'], workingMiB=p['workingBytes']/MIB, privateMiB=p['privateBytes']/MIB) for p in idle]
        row['idleSeconds'] = (dt(idle[1]['utc'])-dt(idle[0]['utc'])).total_seconds()
    records.append(row)

single = [r for r in records if r['repeat']==1]
warm = [r for r in records if r['repeat']>1]
assert len(single) >= 3 and any(r['repeat']==20 and 'idle' in r for r in warm)
summary = dict(platform='Windows local, Slay the Spire 2 0.113.1, headless, instant mode',
    memoryScope='Main game process only; working set includes shared resident pages, private bytes are committed private memory, not equivalent to physical RAM. Render time measured separately after game exit.',
    sampleMs=100, forcedGC=False, singleLaunches=single, repeatedProcesses=warm)
(root/'resource-benchmark-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
lines = ['本机引擎资源测试（0.113.1）', '', '方法：独立启动3次；同进程10场；同进程20场后空闲15秒。所有对战串行，固定牌组和先后手，使用无界面即时模式。没有连接服务器。',
         'MiB=1024×1024字节。驻留内存与私有提交内存是不同口径，不相加。', '', '独立启动：']
for index,r in enumerate(single,1):
    lines.append(f"  {index}: 引擎全程{r['engineSeconds']:.2f}秒，驻留峰值{r['peakWorkingMiB']:.1f}MiB，私有峰值{r['peakPrivateMiB']:.1f}MiB，实际交战{median(r['battleSeconds']):.3f}秒，生成图片{r.get('RenderSeconds',0):.3f}秒")
for r in warm:
    lines += ['',f"同进程连续{r['repeat']}场：总计{r['engineSeconds']:.2f}秒（含启动、清理以及指定空闲），驻留峰值{r['peakWorkingMiB']:.1f}MiB，私有峰值{r['peakPrivateMiB']:.1f}MiB。",
              f"实际交战中位数{median(r['battleSeconds']):.3f}秒；暖场后每次建局+对战中位数{median(r['matchSeconds'][1:]):.3f}秒。"]
    if 'startupSeconds' in r:
        lines.append(f"启动至主菜单{r['startupSeconds']:.3f}秒，启动阶段采样峰值{r['startupSamplePeak']}。")
        peak=max(v['workingMiB'] for v in r['battleSamplePeaks'] if v)
        lines.append(f"交战阶段驻留采样峰值{peak:.1f}MiB。阶段采样峰值可能遗漏100ms内的短峰；全程驻留峰值使用系统PeakWorkingSet。")
    for c in r['cleaned']:
        lines.append(f"  清理第{c['iteration']}场后：驻留{c['workingMiB']:.1f}MiB，私有{c['privateMiB']:.1f}MiB，托管堆{c['managedMiB']:.1f}MiB")
    for i in r.get('idle',[]):
        lines.append(f"  {i['stage']}: 驻留{i['workingMiB']:.1f}MiB，私有{i['privateMiB']:.1f}MiB")
lines += ['', '解释与限制：',
    '- 单场速度主要受启动和资源加载影响，不能只看出牌结算的时间。',
    '- 连续运行后的内存增长需要进一步排查缓存、场景及原生对象，有限场数不能证明永久泄漏或稳定上限。没有强制GC或手动裁剪工作集。',
    '- 使用当前已验证牌组，不是完整卡池最坏情况；独立启动测试没有清空Windows文件缓存。',
    '- 不包含Godot/Steam辅助子进程、父脚本、系统缓存和其他服务；图片渲染内存未采样。',
    '- 本机Windows结果不能等同Linux服务器，也未模拟2核CPU/2GiB内存限制。',
    '- 对现有2核2G服务器，不建议直接常驻上线；需预留操作系统、机器人和其他服务的内存，并先解决连续运行增长问题。', '', '原始目录：']
lines += [r['directory'] for r in records]
(root/'引擎资源测试报告.txt').write_text('\n'.join(lines),encoding='utf-8')
print('Independent launches:',[(round(r['engineSeconds'],2),round(r['peakWorkingMiB'],1)) for r in single])
for r in warm:
    print('Repeat',r['repeat'],'peak MiB',round(r['peakWorkingMiB'],1),'cleaned first/last',r['cleaned'][0],r['cleaned'][-1], 'idle',r.get('idle'))
