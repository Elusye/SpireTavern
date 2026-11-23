# 抽卡与牌组卡图（已部署）

2026-11-23已上线。备份：/root/backup/card-images-20261123-190407。deploy_card_images.sh验证828张缓存、抽卡4次出图、27张牌组2页出图及失败回退后配套安装4个文件，等待本次Bot ready成功。dsh-qqbot与qqbot-duel-engine均active；引擎DLL指纹不变，未重置玩家存档。上线验证目录：/tmp/qqbot-card-offer-n99wgn、/tmp/qqbot-deck-image-ipmTBs。回退只恢复上述备份中的命令文件并重启dsh-qqbot，不恢复players.json.snapshot。卡图缓存目录需保留。

## 牌组卡图

`/牌组`及deck/我的牌组/看牌组别名也已改为图片浏览，每行固定5列，每页最多25张，`/牌组 2`翻页。按存档顺序逐张展示重复牌，升级牌使用升级卡图，底部编号跨页连续（第二页从26开始），与删卡/升级一致；金币、职业、总张数、删卡价格和翻页提示在配文。非法页码不绘图。图片失败回退原有文字牌组，浏览不保存或修改牌组。

27张合成牌组验证通过：两页尺寸2000×2670、2000×534，升级牌、连续编号、越界页码、文字回退及存档不变通过，证据`/tmp/qqbot-deck-image-Fom9X4`；共用绘图模块的抽卡回归4次出图通过，证据`/tmp/qqbot-card-offer-LEgDkg`。渲染共用最多2路并发、15秒超时、12MiB输出限制。抽卡仍为一行最多3张，大小保持不变。以下为上线前隔离验证记录。

`toys.js`抽卡处理器改为async；新抽卡和重复查看待选调用`card_offer_image.js`，使用已缓存Wiki图片拼成一张图。先保存候选牌和每日次数，再生成并发送图片；图片失败返回同一候选牌的原有文字，不重抽、不重复扣次数。序号选择和跳过仍为文字回复，每职业每日一次规则不变。

新增配套文件：`card_offer_image.js`、`render_card_offer.py`、`card_image_manifest.json`。更新toys.js时必须一同安装到commands目录，不能只发toys.js。对战引擎无需变更。

图片默认目录：`/root/qqbot-expanded-stage/wiki-cards`，828张（414种初始/可抽牌及升级版），下载记录`wiki-card-download-results.json`，服务器完整性检查828张通过、381.6MiB。可用`DSH_QQBOT_CARD_IMAGES_DIR`指定其他目录。绘图沿用现有Python/Pillow及QQBOT_REPORT_FONT配置，不在抽卡时请求外站。

标题说明和选择提示随单张图片发送；画布每牌480像素宽，最多3张，下面编号1/2/3。绘图最多2路并发，超出则文字返回；15秒绘图超时和12MiB输出限制。没有图片接口、缺图、绘图错误或发送失败均回退文字。

2026-11-23上线前隔离验证通过：`test_card_offer.mjs`在`/root/qqbot-card-offer-stage`运行，临时存档`/tmp/qqbot-card-offer-nKq3Ek`，fake sendImage捕获4张PNG；重复查看候选不变，选2入库、金币不变、选后每日限制、跳过后每日限制、图片失败的文字回退均通过。该隔离批次未发群消息、未替换正式模块。实际处理器出图预览：`E:/QQBot/local-game-validation/card-preview/card-offer-handler-preview.png`。
