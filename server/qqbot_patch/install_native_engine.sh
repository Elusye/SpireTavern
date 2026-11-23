#!/usr/bin/env bash
set -euo pipefail
source_root=/root/qqbot-engine-linux-probe/v0.111.1
install_root=/root/qqbot-native-engine
game="$install_root/v0.111.1"
stage=/root/qqbot-native-stage
mkdir -p "$game/mods/QQBotEnemyTest" "$install_root/runs"
# Immutable shipped assets share disk blocks with the verified package. Do not edit these links.
python3 - "$source_root" "$game" <<'PY'
import os,pathlib,sys
source,dest=map(pathlib.Path,sys.argv[1:])
files=[source/name for name in ['SlayTheSpire2','SlayTheSpire2.pck','release_info.json','crashpad_handler']]
files+=list(source.glob('*.so*'))
files+=list((source/'data_sts2_linuxbsd_x86_64').rglob('*'))
for file in files:
    if not file.is_file():continue
    target=dest/file.relative_to(source)
    target.parent.mkdir(parents=True,exist_ok=True)
    if not target.exists():os.link(file,target)
PY
cp "$stage/QQBotEnemyTest.dll" "$game/mods/QQBotEnemyTest/QQBotEnemyTest.dll"
cp "$stage/QQBotEnemyTest.json" "$game/mods/QQBotEnemyTest/QQBotEnemyTest.json"
cp "$stage/legacy-card-pool.json" "$install_root/legacy-card-pool.json"
cp "$stage/native_engine_worker.py" "$install_root/worker.py"
chmod 700 "$install_root" "$install_root/runs"
cat > /etc/systemd/system/qqbot-duel-engine.service <<'UNIT'
[Unit]
Description=QQBot original game duel engine (single flight)
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 /root/qqbot-native-engine/worker.py
WorkingDirectory=/root/qqbot-native-engine
RuntimeDirectory=qqbot-duel-engine
RuntimeDirectoryMode=0700
UMask=0077
MemoryMax=800M
MemorySwapMax=128M
CPUQuota=200%
TasksMax=256
PrivateTmp=true
NoNewPrivileges=true
Restart=on-failure
RestartSec=2
TimeoutStopSec=10
KillMode=control-group

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now qqbot-duel-engine
systemctl is-active qqbot-duel-engine
systemctl is-active dsh-qqbot
