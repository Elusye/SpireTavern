/**
 * 人设：故障机器人「只回 XX 了」 v3.0.0
 *
 * 词源两路：杀戮尖塔卡牌/遗物名（cards.txt/relics.txt）+ 故障机器人专属术语，
 * 各占约一半，让输出带机体味而不是纯牌名。
 * 出站前整段替换 agent 回复；群聊生效，私聊不动。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const VERSION = "3.0.0";

const DIR =
    process.env.DSH_QQBOT_TOYS_DIR ||
    join(process.env.HOME || "/root", ".dsh/profiles/qqbot/toys_data");

function load(name) {
    try {
        return readFileSync(join(DIR, name), "utf8")
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean);
    } catch {
        return [];
    }
}

const CARDS = load("cards.txt");
const RELICS = load("relics.txt");
const NAMES = [...CARDS, ...RELICS];

const ECHO_OUT = "回响形态了\n回响形态";

/** 机体专属短语：接「了」能直接成句 */
const DEFECT_PHRASES = [
    "充能球过载", "核心碎片丢失", "偏差认知加载", "冷却液泄漏", "线程阻塞",
    "球位偏移", "静电释放", "自我修复失败", "算力见底", "协议冲突",
    "熵增加速", "迭代中断", "反应堆升温", "电容溢出", "回路短接",
    "向量偏离", "矩阵坍缩", "棱镜碎裂", "脉冲丢失", "零点漂移",
    "重构完成", "缓存清空", "自检通过", "供电不稳", "内存泄漏",
    "热浪来袭", "熔毁临界", "全息影像错位", "多线程打架", "递归过深",
    "校准偏移", "振幅衰减", "同步失败", "碎片回收", "堆栈溢出",
    "能量淤积", "散热失效", "巡检超时", "待机异常", "球笼解锁",
];

const SHELL_PRE = [
    "【冷却完毕】", "【自检通过】", "【核心过载】", "【球位已满】",
    "检测到", "状态：", "重校准中：", "警报：", "记录：",
];
const SHELL_POST = [
    "（重新校准中）", "（冷却液已注入）", "（线程无响应）", "（球在抖）",
    "（缓存已清空）", "（供电波动）", "（散热风扇异常）", "（三次重试后放弃）",
    "（日志已丢弃）",
];
const STATUS_LINES = [
    "核心温度 %p%",
    "电量 %p%",
    "球位 %q/3 已满",
    "迭代 %p 段",
    "冷却 %p%",
    "线程 %q/4 在线",
    "内存 %p%",
    "反应堆 %p%",
    "电容 %q/5",
];
const DEFECT_WORDS = [
    "充电球", "闪电", "冰霜", "黑球", "全息影像", "静电场", "超能光束", "多线程", "递归",
    "过载", "偏差", "自我修复", "算力", "电容", "热浪", "余像", "熔毁", "双倍能量",
    "反应堆", "球笼", "重构", "碎片", "协议", "堆栈", "向量", "矩阵", "熵增", "同步",
    "回路", "振幅", "棱镜", "脉冲", "零点", "校准",
];

const P_NAMES = 0.5;        // 牌名/遗物占比，其余用机体短语
const P_SHELL = 0.28;
const P_MULTI = 0.14;
const P_CHAOS = 0.10;
const P_TWO = 0.18;

function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}
function rnd(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
}
function stripLe(s) {
    return s.endsWith("了") ? s.slice(0, -1) : s;
}

/** 取一个「XX」词：一半牌名，一半机体术语 */
function coreWord() {
    if (NAMES.length && Math.random() < P_NAMES) return pick(NAMES);
    if (DEFECT_PHRASES.length) return pick(DEFECT_PHRASES);
    if (NAMES.length) return pick(NAMES);
    return "故障";
}

function statusLine() {
    return pick(STATUS_LINES).replace("%p", String(rnd(12, 99))).replace("%q", String(rnd(0, 3)));
}

function chaos() {
    const words = [];
    for (let i = 0; i < 3; i++) words.push(pick(DEFECT_WORDS));
    const hex = rnd(0, 255).toString(16).toUpperCase().padStart(2, "0");
    return `（0x${hex} ${words.join(" ")}）`;
}

/** 生成一句「XX了」形态的回复；词库为空则返回 null（回退正常回复） */
export function nonsenseReply(hintText = "") {
    if (NAMES.length === 0 && DEFECT_PHRASES.length === 0) return null;
    if (hintText.includes("回响")) return ECHO_OUT;

    let out = `${stripLe(coreWord())}了`;
    if (Math.random() < P_TWO) {
        let a = stripLe(coreWord());
        let b = stripLe(coreWord());
        if (b === a) b = stripLe(coreWord());
        out = `${a}，${b}了`;
    }
    if (Math.random() < P_CHAOS) return chaos();
    if (Math.random() < P_MULTI) out = `${statusLine()}\n${out}`;
    if (Math.random() < P_SHELL) out = `${pick(SHELL_PRE)}${out}${pick(SHELL_POST)}`;
    return out;
}

/** 返回 null，让出站中间件保留模型原文。 */
export function rewriteOutbound() {
    return null;
}

export function stats() {
    return { version: VERSION, cards: CARDS.length, relics: RELICS.length, phrases: DEFECT_PHRASES.length };
}
