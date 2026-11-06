#!/usr/bin/env bash
# 幂等安装：群聊出站改写为「XX了」人设
set -euo pipefail

PROFILE="${PROFILE:-/root/.dsh/profiles/qqbot}"
PLUGIN="$PROFILE/node_modules/@tencent-connect/dsh-qqbot"
SRC_DIR="${SRC_DIR:-/root/qqbot_patch}"
DATA_DIR="$PROFILE/toys_data"

echo "== 1) 词库确认 =="
ls -l "$DATA_DIR"/cards.txt "$DATA_DIR"/relics.txt 2>/dev/null || echo "!! 缺词库"
echo "  cards=$(wc -l < "$DATA_DIR/cards.txt" 2>/dev/null || echo 0) relics=$(wc -l < "$DATA_DIR/relics.txt" 2>/dev/null || echo 0)"

echo "== 2) 安装 nameliner.js =="
cp "$SRC_DIR/nameliner.js" "$PLUGIN/lib/features/nameliner.js"
node --check "$PLUGIN/lib/features/nameliner.js" && echo "  syntax ok"

echo "== 3) 打补丁：outbound-buffer.js flush =="
python3 - "$PLUGIN/lib/transport/outbound-buffer.js" <<'PY'
import sys, io
p = sys.argv[1]
s = io.open(p, encoding='utf-8').read()
if 'nameliner.js' not in s:
    anchor = 'import { StreamingWriter } from "./streaming-writer.js";'
    assert anchor in s, '缺少 StreamingWriter import 锚点'
    s = s.replace(anchor, anchor + '\nimport { rewriteOutbound } from "../features/nameliner.js";', 1)
if 'rewriteOutbound(this.buffer' not in s:
    old = "            const chunks = chunkMarkdownText(this.buffer, this.limit);"
    new = """            const rewritten = rewriteOutbound(this.buffer, this.record?.replyTarget?.scope);
            const chunks = chunkMarkdownText(rewritten ?? this.buffer, this.limit);"""
    assert old in s, '缺少 chunkMarkdownText 锚点'
    s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8').write(s)
print('  ok')
PY
node --check "$PLUGIN/lib/transport/outbound-buffer.js"

echo "== 4) 打补丁：outbound.js onMessage 直发路径 =="
python3 - "$PLUGIN/lib/transport/outbound.js" <<'PY'
import sys, io
p = sys.argv[1]
s = io.open(p, encoding='utf-8').read()
if 'nameliner.js' not in s:
    anchor = 'import { OutboundBuffer } from "./outbound-buffer.js";'
    assert anchor in s, '缺少 OutboundBuffer import 锚点'
    s = s.replace(anchor, anchor + '\nimport { rewriteOutbound } from "../features/nameliner.js";', 1)
if 'rewriteOutbound(fullText' not in s:
    old = "        this.trackText(sessionId, this.send(record, fullText, 'sendMarkdown'));"
    new = """        const rewritten = rewriteOutbound(fullText, record?.replyTarget?.scope);
        this.trackText(sessionId, this.send(record, rewritten ?? fullText, 'sendMarkdown'));"""
    assert old in s, '缺少 sendMarkdown 锚点'
    s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8').write(s)
print('  ok')
PY
node --check "$PLUGIN/lib/transport/outbound.js"

echo "== 5) 重启 =="
systemctl restart dsh-qqbot.service
sleep 6
systemctl is-active dsh-qqbot.service
tail -4 /root/.dsh/qqbot.log
