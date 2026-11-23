"""Collect latest successful/failed evidence for each original-engine mechanic case."""
import json
import pathlib

root = pathlib.Path(__file__).resolve().parents[1]
labels = {"vulnerable": "易伤及组合倍率", "weak": "虚弱及持续时间", "upgrades": "代表性升级效果", "orbs": "电球、冰球及球槽顺序"}
summary = []
lines = ["0.113.1 原版引擎机制验证", ""]
for name, label in labels.items():
    candidates = sorted(root.glob(f"enemy-runs/*-{name}/result.json"))
    if not candidates:
        raise RuntimeError(f"Missing case: {name}")
    path = candidates[-1]
    result = json.loads(path.read_text(encoding="utf-8-sig"))
    assert result["passed"] and result["victory"], (name, result.get("error"))
    assert result["checks"] and all(check["passed"] for check in result["checks"])
    log = path.with_name("game.log").read_text(encoding="utf-8-sig")
    assert "Hand size" not in log, f"Hand fixture UI error in {name}"
    lines += [f"{label}：通过，{len(result['checks'])} 项检查", f"证据：{path}"]
    for check in result["checks"]:
        lines.append(f"  {check['label']}：实际 {check['actual']}，预期 {check['expected']}")
    lines.append("")
    summary.append({"case": name, "passed": True, "checks": len(result["checks"]), "result": str(path)})
total = sum(item["checks"] for item in summary)
lines += [f"合计 {total} 项检查通过。", "场景固定手牌、初始测试能量20；逐张支付原版费用。完成检查后直接击杀敌人仅用于清理并验证胜利回调，不算作机制测试伤害。", "仅验证以上列明的样例，未验证所有卡牌、全部充能球种类或PvP同时结算。", "游戏仍有 Invalid Task ID 和退出资源清理告警，未在本次修复。"]
(root / "mechanics-summary.json").write_text(json.dumps({"passed": True, "gameVersion": "0.113.1", "totalChecks": total, "cases": summary}, ensure_ascii=False, indent=2), encoding="utf-8")
(root / "机制验证报告.txt").write_text("\n".join(lines), encoding="utf-8")
print(f"PASS: {len(summary)} cases, {total} checks")
for item in summary:
    print(f"{item['case']}: {item['checks']} checks")
