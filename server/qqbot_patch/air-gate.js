/**
 * 读空气门控（air gate）
 *
 * 群消息没 @ 机器人时，决定要不要当成"在跟它说话"：
 *   1. 命中 alwaysKeywords（默认「鸡煲」）→ 无视冷却，一定回（仍受每小时上限）
 *   2. 命中 keywords → 一定插话（受冷却）
 *   3. 否则按概率随机
 *   4. 同群冷却 N 秒、每小时最多 M 次
 *
 * 配置：<profile>/toys_data/air.json（改动后自动热加载，无需重启）
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DEFAULTS = {
    enabled: true,
    probability: 0.06,
    alwaysKeywords: ["鸡煲"],
    keywords: ["故障", "机器人", "球", "电池", "充能", "抽卡", "遗物", "尖塔", "过载", "冷却"],
    cooldownSeconds: 90,
    maxPerHour: 8,
    minLength: 2,
};

export function createAirGate(logger, dataDir) {
    const dir =
        dataDir ||
        process.env.DSH_QQBOT_TOYS_DIR ||
        join(process.env.HOME || "/root", ".dsh/profiles/qqbot/toys_data");
    const cfgPath = join(dir, "air.json");

    let cfg = { ...DEFAULTS };
    let cfgMtime = 0;

    function reload() {
        try {
            const st = statSync(cfgPath);
            if (st.mtimeMs === cfgMtime) return;
            cfgMtime = st.mtimeMs;
            const raw = JSON.parse(readFileSync(cfgPath, "utf8"));
            cfg = { ...DEFAULTS, ...raw };
            logger?.info?.(
                `[air-gate] 配置已加载 p=${cfg.probability} cooldown=${cfg.cooldownSeconds}s/hour=${cfg.maxPerHour} always=${(cfg.alwaysKeywords || []).join("/")}`
            );
        } catch (e) {
            if (cfgMtime === 0)
                logger?.warn?.(`[air-gate] 读配置失败(${cfgPath}): ${e?.message ?? e}，用默认值`);
        }
    }
    reload();

    // groupOpenid -> { last: ts, times: [ts...] }
    const state = new Map();

    return function shouldAnswer(ctx) {
        reload();
        if (!cfg.enabled) return false;
        const msg = ctx?.message;
        if (!msg || msg.kind !== "group") return false;

        const text = String(msg.content ?? "").replace(/\s+/g, " ").trim();
        if (text.length < (cfg.minLength ?? 2)) return false;
        // 命令：放行给 slash-command 处理（那种"免 @"由 SDK 补丁负责），
        // 这里必须返回 true 才能穿过 mentionGate 到达命令中间件
        if (text.startsWith("/")) return true;

        const gid = msg.groupOpenid || "unknown";
        const now = Date.now();
        const rec = state.get(gid) ?? { last: 0, times: [] };
        rec.times = rec.times.filter((t) => now - t < 3600_000);

        const always = (cfg.alwaysKeywords || []).some((k) => k && text.includes(k));
        const hit = (cfg.keywords || []).some((k) => k && text.includes(k));

        // 叫名字：无视冷却与小时上限，只做 3 秒防抖
        if (always) {
            if (now - rec.last < 3000) return false;
            rec.last = now;
            rec.times.push(now);
            state.set(gid, rec);
            logger?.info?.(`[air-gate] 插话 (点名) group=${gid} text=${text.slice(0, 30)}`);
            return true;
        }

        // 每小时硬上限：只约束非点名的插话
        if (rec.times.length >= (cfg.maxPerHour ?? 8)) return false;

        if (now - rec.last < (cfg.cooldownSeconds ?? 90) * 1000) return false;

        const rand = Math.random() < (cfg.probability ?? 0.06);
        if (!hit && !rand) return false;

        rec.last = now;
        rec.times.push(now);
        state.set(gid, rec);
        logger?.info?.(
            `[air-gate] 插话 (${hit ? "关键词" : "随机"}) group=${gid} text=${text.slice(0, 30)}`
        );
        return true;
    };
}
