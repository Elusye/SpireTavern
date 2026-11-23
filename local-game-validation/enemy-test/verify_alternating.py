import json
import sys
import hashlib
from pathlib import Path

root = Path(__file__).resolve().parents[1]
if len(sys.argv) > 1:
    paths = [Path(p) for p in sys.argv[1:]]
else:
    current_hash = hashlib.sha256((root/'build-v0.111.1/QQBotEnemyTest.dll').read_bytes()).hexdigest()
    latest = {}
    for candidate in sorted(root.glob('linux-model-runs/**/alternating-duel.json')):
        record = json.loads(candidate.read_text(encoding='utf-8'))
        if record.get('modelHash') == current_hash and record.get('deckMode') == 'starter':
            latest[record['first']] = candidate
    paths = list(latest.values())
assert len(paths) >= 2
orders = set()
lines = ['轮流行动与首轮保护验证（0.111.1 Linux）', '随机先手；先手首次行动2能量，此后3能量；后手开局10格挡，首次行动开始清除。', '']
for path in paths:
    run = json.loads(path.read_text(encoding='utf-8-sig'))
    result = json.loads(path.with_name('result.json').read_text(encoding='utf-8-sig'))
    assert run['gameVersion'] == result['gameVersion'] == '0.111.1'
    assert result['passed'] and all(c['passed'] for c in result['checks'])
    log = path.with_name('game.log')
    if not log.exists():
        log = path.parent.parent / 'game.log'
    assert 'Exception:' not in log.read_text(encoding='utf-8-sig')
    orders.add(run['first'])
    lines += [f"先手：玩家{run['first']}；后手：玩家{run['rear']}；胜者：{run['winner']}"]
    for index, turn in enumerate(run['turns']):
        actor = turn['actor']
        assert actor == (run['first'] if index % 2 == 0 else run['rear'])
        current = next(p for p in turn['before'] if p['id'] == actor)
        assert current['hp'] > 0 and current['energy'] == (2 if index == 0 else 3)
        if index == 0:
            assert next(p for p in turn['before'] if p['id'] == run['rear'])['block'] == 10
        if index == 1:
            assert current['block'] == 0
        lines.append(f"  回合{turn['turn']} 玩家{actor}：" + ' → '.join(p['card'] for p in turn['plays']))
        lines.append('    HP ' + ' / '.join(f"玩家{p['id']}={p['hp']}" for p in turn['after']))
        for play in turn['plays']:
            assert all(p['hp'] > 0 for p in play['before']), 'Action continued after lethal damage'
    final = run['turns'][-1]['after']
    assert any(p['hp'] == 0 for p in final)
    assert run['winner'] == [p['id'] for p in final if p['hp'] > 0]
    lines += [f"  {len(result['checks'])}项运行内检查通过；证据：{path}", '']
assert orders == {1, 2}, 'Need both initiative orders'
lines += ['验证覆盖两种先后手，不代表胜率平衡已得到统计验证。', '尚为本机原型，完整卡池及完整回合/遗物触发链未认证，线上机器人未改动。']
(root / 'Linux轮流对战验证报告.txt').write_text('\n'.join(lines), encoding='utf-8')
print('PASS: both initiative orders, temporary opening guard, immediate settlement, stop at death')
