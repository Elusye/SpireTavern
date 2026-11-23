import json
from pathlib import Path
import runpy

root = Path(__file__).resolve().parents[1]
latest = sorted(root.glob('enemy-runs/*-duel/result.json'))[-1]
if latest.with_name('alternating-duel.json').exists():
    runpy.run_path(str(Path(__file__).with_name('verify_alternating.py')))
    raise SystemExit(0)
path = sorted(root.glob('enemy-runs/*-duel/duel.json'))[-1]
duel = json.loads(path.read_text(encoding='utf-8-sig'))
result = json.loads(path.with_name('result.json').read_text(encoding='utf-8-sig'))
assert result['passed'] and all(c['passed'] for c in result['checks'])
log = path.with_name('game.log').read_text(encoding='utf-8-sig')
assert 'Exception:' not in log and 'Hand size' not in log, 'Runtime exception in duel log'
hp = {1: 80, 2: 75}
lines = ['双人同时结算原型实测（0.113.1）', '玩家1：铁甲战士；玩家2：故障机器人。额外加入冷静头脑和初始冰球作为测试条件。', '']
for turn in duel['rounds']:
    for intent, state in zip(turn['intents'], turn['result']):
        assert intent['id'] == state['id']
        expected = max(0, hp[state['id']] - max(0, intent['damageReceived'] - intent['block']))
        assert state['hp'] == expected, (turn['round'], state, expected)
        assert 0 <= state['energy'] <= 3
        hp[state['id']] = state['hp']
    lines += [f"交锋{turn['round']}"]
    for index in (1, 2):
        draw = next(d for d in turn['draws'] if d['id'] == index)
        state = next(s for s in turn['result'] if s['id'] == index)
        lines.append(f"  玩家{index}抽牌：{', '.join(draw['cards'])}")
        lines.append(f"  出牌：{' → '.join(turn[f'played{index}'])}；结算后HP {state['hp']}，格挡{state['block']}，能量{state['energy']}，球{','.join(state['orbs'])}")
    lines.append('')
assert any(value == 0 for value in hp.values())
assert duel['winner'] == [index for index, value in hp.items() if value > 0]
lines += [f"胜者：{duel['winner']}；共{len(duel['rounds'])}轮交锋。", f"{len(result['checks'])}项引擎内检查通过；本脚本另核对了每轮双边伤害与格挡结算。", '', '仅支持明确列入白名单的基础卡。未覆盖吸血、反伤、伤害/死亡响应、能力牌、全部遗物。状态在统一结算后生效，按交锋递减；这是PvP适配规则。', '原版只执行卡牌主体、费用、抽牌洗牌、球和数值修正；意图提交由适配层执行，不宣称完整复现原版伤害与死亡钩子。', '线上引擎未修改。']
path.with_name('双人战报.txt').write_text('\n'.join(lines), encoding='utf-8')
print(f"PASS: {len(duel['rounds'])} rounds, {len(result['checks'])} checks, winner={duel['winner']}, HP={hp}")
print(path.with_name('双人战报.txt'))
