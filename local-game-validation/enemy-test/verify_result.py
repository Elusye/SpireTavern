"""Check original-engine combat evidence and write a compact human-readable report."""
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
result = json.loads(path.read_text(encoding="utf-8-sig"))
assert result["passed"] and result["victory"], result.get("error")
events = result["events"]
cards = attacks = 0
lines = ["原版引擎测试敌人战斗记录（0.113.1）", "敌人：60 HP，每回合攻击 6；玩家：铁甲战士初始牌组。", ""]
names = {"STRIKE_IRONCLAD": "打击", "DEFEND_IRONCLAD": "防御", "BASH": "痛击"}
for index, event in enumerate(events):
    kind = event["kind"]
    if kind == "draw":
        lines.append(f"第 {event['turn']} 回合，能量 {event['energy']}，抽牌：" + "、".join(names.get(c, c) for c in event["detail"]["cards"]))
    elif kind == "card_before":
        after = events[index + 1]
        assert after["kind"] == "card_after"
        card = event["detail"]["card"]
        assert after["detail"]["card"] == card
        assert event["energy"] - after["energy"] == event["detail"]["cost"], "Energy was not paid correctly"
        if card == "STRIKE_IRONCLAD":
            assert event["enemyHp"] - after["enemyHp"] == min(6, event["enemyHp"]), "Unexpected basic Strike damage"
        elif card == "DEFEND_IRONCLAD":
            assert after["playerBlock"] - event["playerBlock"] == 5, "Unexpected Defend block"
        else:
            raise AssertionError(f"Add an explicit mechanic check for {card}")
        cards += 1
        lines.append(f"  {names.get(card, card)}：能量 {event['energy']}→{after['energy']}，敌人HP {event['enemyHp']}→{after['enemyHp']}，自身格挡 {event['playerBlock']}→{after['playerBlock']}")
    elif kind == "enemy_attack_start":
        after = events[index + 1]
        assert after["kind"] == "enemy_attack_end"
        assert event["playerHp"] - after["playerHp"] == max(0, 6 - event["playerBlock"])
        assert after["playerBlock"] == max(0, event["playerBlock"] - 6)
        attacks += 1
        lines.append(f"  敌人攻击6：自身HP {event['playerHp']}→{after['playerHp']}，格挡 {event['playerBlock']}→{after['playerBlock']}")
victory = events[-1]
assert victory["kind"] == "victory" and victory["enemyHp"] == 0
assert cards > 0 and attacks > 0
lines += ["", f"验证通过：{cards} 次出牌，{attacks} 次敌人攻击；第 {victory['turn']} 回合获胜。", "胜利后燃烧之血按原版回血；本次未覆盖易伤、虚弱、升级牌、充能球或PvP。"]
report = path.with_name("战斗记录.txt")
report.write_text("\n".join(lines), encoding="utf-8")
print(f"PASS: {cards} card plays, {attacks} enemy attacks, victory on turn {victory['turn']}")
print(report)
