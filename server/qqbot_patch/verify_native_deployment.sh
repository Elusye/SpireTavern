#!/usr/bin/env bash
set -euo pipefail
module=/root/.dsh/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib/commands
systemctl is-active dsh-qqbot
systemctl is-active qqbot-duel-engine
test -S /run/qqbot-duel-engine/engine.sock
python3 - "$module" <<'PY'
import hashlib,json,pathlib,sys
module=pathlib.Path(sys.argv[1])
assert json.loads((module/'native_duel.config.json').read_text())['enabled'] is True
root=pathlib.Path('/root/qqbot-native-engine')
assert json.loads((root/'v0.111.1/release_info.json').read_text())['version']=='v0.111.1'
assert json.loads((root/'saved-deck-smoke.json').read_text())['passed']
print(json.dumps({'nativeEnabled':True,'version':'0.111.1',
    'modelHash':hashlib.sha256((root/'v0.111.1/mods/QQBotEnemyTest/QQBotEnemyTest.dll').read_bytes()).hexdigest(),
    'savedDeckSmokePassed':True}))
PY
DSH_QQBOT_TOYS_DIR=/tmp/qqbot-native-post-deploy node --input-type=module - "$module" <<'JS'
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const root=process.argv[2];
const {toysCommands}=await import(pathToFileURL(root+'/toys.js'));
const {nativeDuelEnabled}=await import(pathToFileURL(root+'/native_duel.js'));
assert.ok(nativeDuelEnabled());
const names=toysCommands().flatMap(c=>c.name);
assert.ok(names.includes('对战')&&names.includes('升级'));
console.log(JSON.stringify({installedCommandsPassed:true,nativeEnabled:true}));
JS
