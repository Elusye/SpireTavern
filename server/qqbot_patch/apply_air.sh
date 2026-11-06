#!/usr/bin/env bash
# 幂等安装：读空气门控 + 群命令免 @
set -euo pipefail

PROFILE="${PROFILE:-/root/.dsh/profiles/qqbot}"
PLUGIN="$PROFILE/node_modules/@tencent-connect/dsh-qqbot"
SDK="$PROFILE/node_modules/@tencent-connect/qqbot-nodejs/dist/middleware/slash-command.js"
# pnpm 布局下包在 .pnpm 里，动态定位
if [ ! -f "$SDK" ]; then
  SDK="$(find "$PROFILE/node_modules" -name slash-command.js -path "*qqbot-nodejs/dist/middleware*" 2>/dev/null | head -n 1)"
fi
[ -f "$SDK" ] || { echo "!! 找不到 slash-command.js"; exit 1; }
echo "  SDK=$SDK"
SRC_DIR="${SRC_DIR:-/root/qqbot_patch}"
DATA_DIR="$PROFILE/toys_data"

echo "== 1) air-gate.js =="
mkdir -p "$PLUGIN/lib/features"
cp "$SRC_DIR/air-gate.js" "$PLUGIN/lib/features/air-gate.js"
node --check "$PLUGIN/lib/features/air-gate.js" && echo "  syntax ok"

echo "== 2) air.json（保留用户改动，只补缺字段）=="
mkdir -p "$DATA_DIR"
python3 - "$DATA_DIR/air.json" <<'PY'
import json, io, os, sys
p = sys.argv[1]
default = {
    "enabled": True,
    "probability": 0.06,
    "alwaysKeywords": ["鸡煲"],
    "keywords": ["故障", "机器人", "球", "电池", "充能", "抽卡", "遗物", "尖塔", "过载", "冷却"],
    "cooldownSeconds": 90,
    "maxPerHour": 8,
    "minLength": 2,
}
cur = {}
if os.path.exists(p):
    try:
        cur = json.load(io.open(p, encoding="utf-8"))
    except Exception:
        cur = {}
for k, v in default.items():
    cur.setdefault(k, v)
if "鸡煲" not in cur.get("alwaysKeywords", []):
    cur["alwaysKeywords"] = ["鸡煲"] + [k for k in cur.get("alwaysKeywords", []) if k != "鸡煲"]
io.open(p, "w", encoding="utf-8").write(json.dumps(cur, ensure_ascii=False, indent=2) + "\n")
print(io.open(p, encoding="utf-8").read())
PY

echo "== 3) mentionGate 挂 isImplicitMention =="
python3 - "$PLUGIN/lib/gateway/middleware-setup.js" <<'PY'
import sys, io
p = sys.argv[1]
s = io.open(p, encoding='utf-8').read()
if 'air-gate.js' not in s:
    anchor = 'import { getHistoryStore, historyGroupKey } from "../features/history-store.js";'
    assert anchor in s, '缺少 history-store import 锚点'
    s = s.replace(anchor, anchor + '\nimport { createAirGate } from "../features/air-gate.js";', 1)
if 'const airGate =' not in s:
    anchor2 = "    // 5. 群聊 @bot 门控"
    assert anchor2 in s, '缺少门控注释锚点'
    s = s.replace(anchor2, "    const airGate = createAirGate(logger, null);\n" + anchor2, 1)
if 'isImplicitMention: airGate' not in s:
    old = """    bot.use(mentionGate({
        requireMentionInGroup: config.requireMention,
    }));"""
    new = """    bot.use(mentionGate({
        requireMentionInGroup: config.requireMention,
        isImplicitMention: airGate,
    }));"""
    assert old in s, '缺少 mentionGate 调用锚点'
    s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8').write(s)
print('  ok')
PY

echo "== 4) 群命令免 @（改 SDK slash-command）=="
if grep -q "DSH 补丁：群命令免 @" "$SDK"; then
  echo "  已打过，跳过"
else
  python3 - "$SDK" <<'PY'
import sys, io
p = sys.argv[1]
s = io.open(p, encoding='utf-8').read()
old = """        // 群聊场景：必须 @bot 才触发命令
        if (ctx.message.kind === 'group') {
            const msg = ctx.message;
            const wasMentioned = msg.rawEventType === 'GROUP_AT_MESSAGE_CREATE' ||
                msg.mentions?.some((m) => m.is_you);
            if (!wasMentioned) {
                await next();
                return;
            }
        }"""
new = """        // DSH 补丁：群命令免 @ —— 只要以 / 开头就匹配命令
"""
assert old in s, '找不到群 @ 校验锚点，SDK 版本可能变了'
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8').write(s)
print('  patched')
PY
fi
node --check "$SDK" && echo "  syntax ok"

echo "== 5) 重启 =="
systemctl restart dsh-qqbot.service
sleep 6
systemctl is-active dsh-qqbot.service
tail -5 /root/.dsh/qqbot.log
