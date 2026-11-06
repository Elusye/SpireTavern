/**
 * 危险指令的管理员校验。
 *
 * 白名单来源（两者取并集，改文件无需重启）：
 *   1. 环境变量 DSH_QQBOT_ADMINS，逗号分隔
 *   2. <toys_data>/admins.json，形如 {"openids": ["XXXX..."]} 或 ["XXXX..."]
 *
 * 白名单为空时 → 对所有人关闭（fail-closed），并提示怎么配。
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const DENIED = "⚠️ 无权限执行此命令（该指令仅管理员可用）";
const HINT = "⚠️ 还没配置管理员：先把 /bot-me 返回的 openid 写进 admins.json";

let cache = { mtimeMs: -1, ids: [] };
let warnedMissing = false;

function dataDir() {
    return process.env.DSH_QQBOT_TOYS_DIR
        || join(process.env.HOME || "/root", ".dsh", "profiles", "qqbot", "toys_data");
}

function envIds() {
    return (process.env.DSH_QQBOT_ADMINS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}

function loadIds(logger) {
    const fromEnv = envIds();
    const file = join(dataDir(), "admins.json");
    if (!existsSync(file)) {
        if (!warnedMissing) {
            logger?.warn?.(`im-qqbot: 未找到 ${file}，危险指令暂对所有人关闭`);
            warnedMissing = true;
        }
        return fromEnv;
    }
    try {
        const st = statSync(file);
        if (st.mtimeMs !== cache.mtimeMs) {
            const raw = JSON.parse(readFileSync(file, "utf8"));
            const list = Array.isArray(raw) ? raw : Array.isArray(raw?.openids) ? raw.openids : [];
            const merged = [...new Set([...fromEnv, ...list.filter(Boolean)])];
            cache = { mtimeMs: st.mtimeMs, ids: merged };
            logger?.info?.(`im-qqbot: 管理员白名单已加载 ${merged.length} 人`);
        }
        return cache.ids;
    } catch (err) {
        logger?.warn?.(`im-qqbot: admins.json 解析失败: ${err?.message ?? err}`);
        return fromEnv;
    }
}

/** 供命令对象使用的 authorized 回调 */
export function createAdminAuth(logger) {
    return (ctx) => {
        const ids = loadIds(logger);
        if (ids.length === 0) return HINT;
        const senderId = ctx?.message?.senderId;
        if (senderId && ids.includes(senderId)) return true;
        logger?.warn?.(`im-qqbot: 危险指令被拒 sender=${senderId ?? "(missing)"}`);
        return DENIED;
    };
}

/** 供 /help 之类的地方做“只给管理员看”的判断，不发拒绝消息 */
export function isAdmin(ctx, logger) {
    const senderId = ctx?.message?.senderId;
    return Boolean(senderId && loadIds(logger).includes(senderId));
}
