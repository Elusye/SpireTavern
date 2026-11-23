#!/usr/bin/env bash
set -euo pipefail

profile=${PROFILE:-/root/.dsh/profiles/qqbot}
sdk="$profile/node_modules/.pnpm/@tencent-connect+qqbot-nodejs@1.0.5/node_modules/@tencent-connect/qqbot-nodejs/dist"
bot="$sdk/QQBot.js"
gateway="$sdk/protocol/gateway/gateway-connection.js"
toys="$profile/node_modules/@tencent-connect/dsh-qqbot/lib/commands/toys.js"
log=/root/.dsh/qqbot.log
stage=$(mktemp -d)
trap 'rm -f -- "$stage/bot.mjs" "$stage/gateway.mjs"; rmdir -- "$stage"' EXIT
node --input-type=module --check < "$1"
python3 - "$bot" "$gateway" "$stage" <<'PY'
from pathlib import Path
import sys

bot, gateway, stage = map(Path, sys.argv[1:])
def replace_once(source, old, new):
    if source.count(old) != 1:
        raise SystemExit("Unexpected SDK source: " + old)
    return source.replace(old, new, 1)

source = gateway.read_text(encoding="utf-8")
if "// group-welcome subscription" not in source:
    source = replace_once(source, "const intents = this.opts.intents ?? FULL_INTENTS;",
        "const intents = (this.opts.intents ?? FULL_INTENTS) | (1 << 24); // group-welcome subscription")
    source = replace_once(source, 'const saved = this.opts.session?.load();',
        'const saved = undefined; // Identify with the new subscription on process startup.')
    source = replace_once(source, 'onRawEvent(result.type, result.data)',
        'onRawEvent(result.type, result.data, payload.id)')
(stage / "gateway.mjs").write_text(source, encoding="utf-8")

source = bot.read_text(encoding="utf-8")
if "// group-welcome handler" not in source:
    source = 'import { readFileSync as readWelcomeGroups } from "node:fs";\n' + source
    source = replace_once(source, "        this.gateway = new GatewayConnection({",
        "        const welcomeEvents = new Set();\n        this.gateway = new GatewayConnection({")
    source = replace_once(source, "            onRawEvent: (type, data) => {", r'''            onRawEvent: (type, data, eventId) => {
                // group-welcome handler
                if (type === "GROUP_MEMBER_ADD" && data?.group_openid && (eventId ?? data.event_id)) {
                    const id = eventId ?? data.event_id;
                    if (!welcomeEvents.has(id)) {
                        welcomeEvents.add(id);
                        if (welcomeEvents.size > 512) welcomeEvents.delete(welcomeEvents.values().next().value);
                        void (async () => {
                            const dir = process.env.DSH_QQBOT_TOYS_DIR || "/root/.dsh/profiles/qqbot/toys_data";
                            let groups;
                            try {
                                groups = JSON.parse(readWelcomeGroups(dir + "/welcome-groups.json", "utf8"));
                            } catch (error) {
                                if (error.code !== "ENOENT") console.warn("[group-welcome] cannot read settings");
                                return;
                            }
                            if (!Array.isArray(groups) || !groups.includes(data.group_openid)) return;
                            const token = await this.tokenManager.getAccessToken(this.creds.appId, this.creds.clientSecret);
                            await this.apiClient.request(token, "POST", "/v2/groups/" + encodeURIComponent(data.group_openid) + "/messages", {
                                content: "欢迎新朋友，喵！有空先看看群公告，群规和常用信息都在那里。有疑问也可以在群里问我～",
                                msg_type: 0, event_id: id, msg_seq: 1,
                            });
                            console.info("[group-welcome] QQ API accepted");
                        })().catch((error) => console.warn("[group-welcome] send failed", error?.bizCode ?? error?.httpStatus ?? "unknown"));
                    }
                }''')
(stage / "bot.mjs").write_text(source, encoding="utf-8")
PY
node --check "$stage/bot.mjs"
node --check "$stage/gateway.mjs"
tag=$(date +%s)
for file in "$bot" "$gateway" "$toys"; do cp -p "$file" "$file.bak.welcome.$tag"; done
rollback() {
    for file in "$bot" "$gateway" "$toys"; do cp -p "$file.bak.welcome.$tag" "$file"; done
    systemctl restart dsh-qqbot
}
trap 'rollback; rm -f -- "$stage/bot.mjs" "$stage/gateway.mjs"; rmdir -- "$stage"' EXIT
offset=$(wc -c < "$log")
cat "$stage/bot.mjs" > "$bot"
cat "$stage/gateway.mjs" > "$gateway"
cp "$1" "$toys"
systemctl restart dsh-qqbot
for attempt in {1..15}; do
    if systemctl is-active --quiet dsh-qqbot &&
        tail -c "+$((offset + 1))" "$log" | grep -Fq 'Bot ready!'; then
        trap 'rm -f -- "$stage/bot.mjs" "$stage/gateway.mjs"; rmdir -- "$stage"' EXIT
        echo "Bot ready with group member subscription"
        exit 0
    fi
    sleep 2
done
exit 1
