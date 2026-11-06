#!/usr/bin/env bash
# 把「故障机器人小玩具」命令注入 dsh-qqbot 插件（幂等，可重复执行）
# 注意：`dsh plugin ... add/update` 会重装 node_modules，覆盖后需重跑本脚本。
set -eu
PROFILE=${PROFILE:-/root/.dsh/profiles/qqbot}
PKG="$PROFILE/node_modules/@tencent-connect/dsh-qqbot"
SRC_DIR=${SRC_DIR:-/root/qqbot_patch}

if [ ! -d "$PKG/lib/commands" ]; then
  echo "!! 插件目录不存在: $PKG"; exit 1
fi

echo "=== 1) 数据文件 ==="
mkdir -p "$PROFILE/toys_data"
SRCDATA=""
for d in /root/server/data/plugins/astrbot_plugin_defect_toys $SRC_DIR/toys_data; do
  if [ -f "$d/cards.txt" ]; then SRCDATA="$d"; break; fi
done
if [ -z "$SRCDATA" ]; then echo "!! 找不到 cards.txt"; exit 1; fi
cp -f "$SRCDATA/cards.txt" "$PROFILE/toys_data/cards.txt"
cp -f "$SRCDATA/relics.txt" "$PROFILE/toys_data/relics.txt" 2>/dev/null || true
echo "数据源: $SRCDATA"
echo "cards=$(grep -cve '^\s*$' "$PROFILE/toys_data/cards.txt") relics=$(grep -cve '^\s*$' "$PROFILE/toys_data/relics.txt")"

echo "=== 2) 拷贝命令实现 ==="
cp -f "$SRC_DIR/toys.js" "$PKG/lib/commands/toys.js"

echo "=== 3) 注入 buildCommandList ==="
python3 - "$PKG/lib/commands/index.js" <<'PY'
import io, sys
p = sys.argv[1]
src = io.open(p, encoding='utf-8').read()
if 'toys.js' in src:
    print('已注入，跳过')
    raise SystemExit(0)
src = src.replace(
    'import { helpCommand } from "./help.js";',
    'import { helpCommand } from "./help.js";\nimport { toysCommands } from "./toys.js";'
)
src = src.replace(
    '        statusCommand(deps),\n    ];',
    '        statusCommand(deps),\n        // 故障机器人小玩具\n        ...toysCommands(),\n    ];'
)
io.open(p, 'w', encoding='utf-8').write(src)
print('已注入 toys 命令')
PY

echo "=== 4) 校验 ==="
grep -n "toysCommands" "$PKG/lib/commands/index.js"
node --check "$PKG/lib/commands/toys.js" && echo "toys.js 语法 OK"

echo "=== 5) 重启服务 ==="
systemctl restart dsh-qqbot.service
sleep 12
systemctl is-active dsh-qqbot.service
tail -6 /root/.dsh/qqbot.log
