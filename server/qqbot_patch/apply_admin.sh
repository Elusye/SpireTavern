#!/usr/bin/env bash
# 幂等：把危险指令改成仅管理员可用
set -e
PROFILE=/root/.dsh/profiles/qqbot
P=$PROFILE/node_modules/@tencent-connect/dsh-qqbot/lib
PATCH=/root/qqbot_patch

mkdir -p "$P/features" "$PROFILE/toys_data"
cp "$PATCH/admin-guard.js" "$P/features/admin-guard.js"
echo "guard copied"

python3 - "$P/commands/index.js" <<'PY'
import sys, re
path = sys.argv[1]
src = open(path, encoding="utf-8").read()
orig = src

IMPORT = 'import { createAdminAuth } from "../features/admin-guard.js";'
DECL = ('const ADMIN_ONLY = new Set(["new", "reset", "clear", "compact", "stop", '
        '"bot-status", "model", "preset"]);')

if IMPORT not in src:
    lines = src.split("\n")
    last_import = max(i for i, l in enumerate(lines) if l.startswith("import "))
    lines.insert(last_import + 1, IMPORT)
    lines.insert(last_import + 2, DECL)
    src = "\n".join(lines)
    print("  import + ADMIN_ONLY inserted")

BLOCK = """    // DSH 补丁：危险指令仅管理员可用
    const adminAuth = createAdminAuth(deps.logger);
    for (const cmd of commands) {
        const names = Array.isArray(cmd.name) ? cmd.name : [cmd.name];
        if (names.some((n) => ADMIN_ONLY.has(n))) cmd.authorized = adminAuth;
    }
"""
if "createAdminAuth(deps.logger)" not in src:
    marker = "    return commands;"
    if marker not in src:
        raise SystemExit("!! 找不到 return commands;")
    src = src.replace(marker, BLOCK + marker, 1)
    print("  admin gate applied")

if src != orig:
    open(path, "w", encoding="utf-8").write(src)
    print("  index.js updated")
else:
    print("  index.js 未变化（已打过）")
PY

# 白名单文件（只在不存在时创建，避免覆盖）
if [ ! -f "$PROFILE/toys_data/admins.json" ]; then
  echo '{"openids": []}' > "$PROFILE/toys_data/admins.json"
  echo "admins.json created (空)"
fi

echo "=== 语法检查 ==="
node --check "$P/features/admin-guard.js" && echo "  guard ok"
node --check "$P/commands/index.js" && echo "  index ok"

echo "=== 重启服务 ==="
systemctl restart dsh-qqbot.service
sleep 6
systemctl is-active dsh-qqbot.service
tail -3 /root/.dsh/qqbot.log
