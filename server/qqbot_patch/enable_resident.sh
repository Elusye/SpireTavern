#!/usr/bin/env bash
set -euo pipefail
root=/root/qqbot-native-engine
# Refuse to interrupt an unfinished resident job.
python3 - "$root" <<'PY'
import json,pathlib,sys
root=pathlib.Path(sys.argv[1])
for record in root.joinpath('runs').glob('*/host.json'):
    if not record.with_name('resident-result.json').exists():
        raise SystemExit('Unfinished resident job; postpone restart')
assert json.loads((root/'resident-accepted.json').read_text())['passed']
PY
cp "$root/worker.py" "$root/worker.py.before-prewarm"
cp /root/qqbot-native-stage/native_engine_worker.py "$root/worker.py"
python3 -m py_compile "$root/worker.py"
python3 - "$root" <<'PY'
import json,pathlib,sys
path=pathlib.Path(sys.argv[1])/'speed.json'
temp=path.with_suffix('.tmp')
temp.write_text(json.dumps({'fps':30,'scale':1,'resident':True}))
temp.replace(path)
PY
systemctl set-property --runtime qqbot-duel-engine.service CPUQuota=200%
systemctl set-property qqbot-duel-engine.service CPUQuota=200%
systemctl restart qqbot-duel-engine
sleep 1
systemctl is-active qqbot-duel-engine
systemctl is-active dsh-qqbot
