# 原版对战测试上线（2026-11-22）

## 当前扩展卡池已上线（2026-11-22）

五职业各79张非初始牌，共395张；新增145张，排除狂宴、狩猎、王国资产、巨镰、遗传算法。当前DLL指纹1b260d71c3000ff4efc1b5b5dd6da82a1b3ca32c1887dc52ff531e218e3748cc。模型、职业目录、toys.js和战报适配器已配套更新，原有常驻模式不变，未重置玩家存档。

备份：/root/backup/expanded-pool-20261122-221121；部署暂存与验收记录：/root/qqbot-expanded-stage。deploy_expanded_pool.sh先核验395张目录及存档兼容、备份、等待对战空闲，再停止服务替换DLL，使用合成存档和假sendImage验证后启动机器人并等待本次Bot ready。verify_expanded_deployment.sh核验安装指纹和79张目录；smoke_expanded_cards.mjs验证RUPTURE+、INFERNAL_BLADE+、WHITE_NOISE+实际打出及新牌出图，7回合样例引擎3.491秒（仅单个样例，不代表平均性能）。正式两个服务均active，CPU200%、内存800MiB、resident=true，服务配置缓存已刷新。

本地934次逐牌检查、60项机制断言、8场完整对战及图片证据仍为同一DLL。原版headless/退出清理告警仍存在，未承诺所有组合或长期稳定。后续不能单独发布toys.js，也不能原地覆盖运行中DLL。若回退，必须考虑上线后玩家已抽取新牌，不能将新存档直接交给旧模型；不要恢复旧players.json覆盖玩家进度。以下常驻优化数据为此前94fc版本的历史基线。

## 当前性能模式（2026-11-22晚更新）

已启用常驻引擎，优化基线DLL SHA256为94fc7f841d3132631fcf81fba0e167a5f018896f3c37b6663e6da2e8e3b3e527。resident_host在每场后调用原版ReturnToMainMenu清理，重新加载下一场职业、牌组与种子；空闲时暂停场景树，Python通过文件信箱传递请求。仍同时只运行一场，不向聊天进程加载游戏。

运行参数在/root/qqbot-native-engine/speed.json，当前fps30、scale1、resident=true；服务CPU配额200%，MemoryMax仍800MiB。提高帧率及时间倍率的对照没有明显收益，未启用这些加速参数。常驻引擎每20场或清理后RSS达到720MiB回收；空闲后台自动预热新进程。帧率、倍率修改会触发下一次预热重建。首次加载新职业资源或回收后若预热未完成，仍可能比热场慢。

对照证据：local-game-validation/resident-benchmark.json、resident-performance-summary.json。三种固定牌组冷启动约18～26秒，热场连续20场约4～10秒，完整记录可比较的样本一致，20场均通过且未检测到.NET异常；实测RSS最高约719MiB，尚不能断言长期内存完全稳定，因此必须保留自动回收。上线后完整命令、升级牌、busy、图片与存档不变测试也通过，服务保持active。耗时为引擎完成时间，QQ图片上传另计。

性能回退：speed.json设resident=false，下一场会先停止常驻进程再使用单场冷启动，同一模型和规则不变。Python工作者旧版保存在worker.py.before-resident、worker.py.before-prewarm；之前7a98... DLL备份在QQBotEnemyTest.dll.before-resident。若完整回退DLL，须同步回退工作者并重启qqbot-duel-engine以更新模型指纹；不需要重启聊天机器人。以下为首次上线阶段记录。

QQ机器人已启用0.111.1原版轮流对战。/对战读取双方当前职业与保存牌组，包含升级牌；随机先手、先手首次2能量、后手10临时格挡，直到死亡。铁甲战士沿用旧bot规则，初始最大生命额外+6。/升级一并上线，每天每职业一次。存档结构未迁移，玩家数据未重置。

## 运行位置

- 机器人服务：dsh-qqbot；源码安装目录：/root/.dsh/profiles/qqbot/node_modules/@tencent-connect/dsh-qqbot/lib/commands。
- 引擎服务：qqbot-duel-engine；/etc/systemd/system/qqbot-duel-engine.service。
- 工作者：/root/qqbot-native-engine/worker.py；游戏：其下v0.111.1，调用DLL位于mods/QQBotEnemyTest。
- 本地通信：/run/qqbot-duel-engine/engine.sock，权限0600；机器人和服务均root运行，不开放网络端口。
- 每场日志与记录：/root/qqbot-native-engine/runs/<随机UUID>。输入只存职业、卡牌和随机种子，不传QQ用户ID或昵称。
- 单场独立进程，最多同时1场；忙时直接提示稍后重试。子进程90秒超时，服务MemoryMax800MiB、swap128MiB、CPU100%、Tasks256。游戏与机器人分属不同内存控制组。声音关闭、Steam关闭、独立临时存档；不会修改实际玩家存档。

上线DLL SHA256：7a98dc9ddadaeaaaeb163928aacad4e8123c341829baf4e85392bdc7053e17e7。

## 验证与证据

install_native_engine.sh只部署独立工作者；smoke_native_stage.sh使用合成存档和假sendImage验证整个命令链路，不发QQ消息，核对升级次数、真实牌组传入、升级牌、86初始HP、并发busy、图片以及存档不变。smoke_native_saved.py只读实际存档，验证铁甲战士/静默猎手分别对故障机器人，另验证储君与亡灵契约师的升级牌输入。14份活跃存档与3份归档牌组均兼容。

deploy_native_duel.sh备份并替换命令文件，等待本次重启后的Bot ready；失败自动恢复程序文件，不恢复或覆盖玩家数据。verify_native_deployment.sh核验正式命令、开关、版本与服务状态，不触发群消息。已得到两个服务active和本次Bot ready。真实群内图片发送仍需用户发起一场/对战验证。

完整卡池基线的544次出牌、26项机制断言和10场战斗属于此前DLL 704e81d02bd6a06df6a55527053ca7ca8111b8a60d216fc5fd3c53d56ccca094。基线DLL另存local-game-validation/model-snapshots/QQBotEnemyTest-legacy-coverage.dll，可用verify_legacy_coverage.py --dll该路径复核。上线版本在此基础上加入真实存档输入、随机种子、+标记和铁甲战士+6；部署链路另做上面的实际输入与命令测试，不能把旧批次误称为新DLL完整卡池回归。

## 开关与回滚

即时关闭新入口：将commands/native_duel.config.json中的enabled设为false，下一次/对战会使用保留的旧模拟器，不需要重启。启用时设true。卡牌结算以0.111.1为准，部分旧卡表的文字描述尚未同步。

本次程序和玩家存档快照备份：/root/backup/native-duel-20261122-123753。完整程序回滚可恢复该目录中的toys.js、render_duel_report.py及已有duel_record_adapter.py到commands，再重启dsh-qqbot；不需要恢复players.json.snapshot。native_duel.js和配置文件即使保留，旧toys.js也不会调用它们。若不再测试，可停止qqbot-duel-engine；不要启动旧NapCat/AstrBot容器。

排查先看journalctl -u qqbot-duel-engine和对应runs/<UUID>/result.json、game.log；机器人桥接失败只记错误类型与run UUID，向用户返回明确失败，不偷偷切换结算规则。仍有原版headless/退出资源清理告警；未承诺任意组合或长期运行稳定。

