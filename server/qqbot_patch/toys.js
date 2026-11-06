import { randomUUID } from "node:crypto";
/**
 * 故障机器人小玩具（dsh-qqbot 命令扩展）
 *   /抽卡   /遗物   /扔   /捞   /help
 *
 * 与 AstrBot 版 astrbot_plugin_defect_toys 行为一致：
 *   - 抽卡/遗物按「用户 + 当天日期」确定性随机（同一天问两次结果相同）
 *   - /help 里的管理员段落只对白名单用户显示
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isAdmin } from "../features/admin-guard.js";

const DATA_DIR = process.env.DSH_QQBOT_TOYS_DIR || "/root/.dsh/profiles/qqbot/toys_data";

function loadLines(fname) {
    try {
        return readFileSync(join(DATA_DIR, fname), "utf8")
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0 && !s.startsWith("#"));
    } catch {
        return [];
    }
}

const CARDS = loadLines("cards.txt");
const RELICS = loadLines("relics.txt");
const ALL = CARDS.concat(RELICS);
const NAMES = ALL.length ? ALL : ["打击", "防御", "痛击"];

const FORTUNES = [
    "运势：能量溢出，本回合可以乱来",
    "运势：手牌全废，但球还在转",
    "运势：抽到这张说明你今天不适合上班",
    "运势：冷却液充足，情绪稳定",
    "运势：核心过载，建议少说话",
    "运势：三颗球同步了，罕见",
    "运势：别看了，牌堆已经在冒烟",
    "运势：今日宜充电，忌开会",
    "运势：偏差认知，你看什么都像牌",
    "运势：运势良好，但机体不保证",
];

const CHARGE_HINTS = [
    "接受充能，电容 +1",
    "冷却液注入，机体抖了一下",
    "又一颗球被点亮",
    "线程稳了一点，但还是不太对",
];
const DISCHARGE = [
    "（机体放电，全场静默两秒）",
    "【放电】球位已满，输出过载……了",
    "充能完成，机体短暂地清醒了一下，然后忘了自己要说什么了",
    "（三颗球同时亮起，静电顺着手柄爬上来）",
];
const CHARGE_MAX = 5;
const CHARGE_WINDOW_MS = 600 * 1000;

// ── 确定性随机（FNV-1a + mulberry32）──
function hash32(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
}
function rng(seed) {
    let a = hash32(seed);
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
function sample(r, arr, k) {
    const pool = arr.slice();
    const out = [];
    const n = Math.min(k, pool.length);
    for (let i = 0; i < n; i++) {
        const j = i + Math.floor(r() * (pool.length - i));
        const tmp = pool[i];
        pool[i] = pool[j];
        pool[j] = tmp;
        out.push(pool[i]);
    }
    return out;
}
function today() {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${mm}-${dd}`;
}
const who = (ctx) => ctx?.message?.senderName || ctx?.message?.senderId || "某台机体";
const uid = (ctx) => String(ctx?.message?.senderId ?? "anon");

// ── 漂流瓶：匿名存储，只留文本和时间 ──
const BOTTLE_FILE = join(DATA_DIR, "bottles.json");
const BOTTLE_MAX = 500;
function loadBottles() {
    try {
        const arr = JSON.parse(readFileSync(BOTTLE_FILE, "utf8"));
        return Array.isArray(arr) ? arr.filter((b) => b && typeof b.t === "string" && b.t) : [];
    } catch {
        return [];
    }
}
function saveBottles(arr) {
    try {
        writeFileSync(BOTTLE_FILE, JSON.stringify(arr), "utf8");
    } catch {}
}

function drawCards(id, day, k = 3) {
    const r = rng(`${id}|${day}`);
    return sample(r, CARDS.length ? CARDS : NAMES, k);
}

// ── 玩家存档：金币 / 牌组 / 删卡价格 / 待选牌 ──
const PLAYER_FILE = join(DATA_DIR, "players.json");
const JOBS = {
    Ironclad: {"name": "铁甲战士", "relic": "燃烧之血", "starter": ["StrikeIronclad", "StrikeIronclad", "StrikeIronclad", "StrikeIronclad", "StrikeIronclad", "DefendIronclad", "DefendIronclad", "DefendIronclad", "DefendIronclad", "Bash"], "pool": ["Bludgeon", "IronWave", "Taunt", "PommelStrike", "TwinStrike", "BodySlam", "Stomp"]},
    Silent: {"name": "静默猎手", "relic": "蛇之戒指", "starter": ["StrikeSilent", "StrikeSilent", "StrikeSilent", "StrikeSilent", "StrikeSilent", "DefendSilent", "DefendSilent", "DefendSilent", "DefendSilent", "DefendSilent", "Neutralize", "Survivor"], "pool": ["Dash", "Deflect", "LegSweep", "Slice", "SuckerPunch", "Backflip", "Adrenaline", "Pinpoint"]},
    Regent: {"name": "储君", "relic": "天赋君权", "starter": ["StrikeRegent", "StrikeRegent", "StrikeRegent", "StrikeRegent", "DefendRegent", "DefendRegent", "DefendRegent", "DefendRegent", "FallingStar", "Venerate"], "pool": ["CloakOfStars", "Comet", "Devastate", "GammaBlast", "LunarBlast"]},
    Necrobinder: {"name": "亡灵契约师", "relic": "缚魂命匣", "starter": ["StrikeNecrobinder", "StrikeNecrobinder", "StrikeNecrobinder", "StrikeNecrobinder", "DefendNecrobinder", "DefendNecrobinder", "DefendNecrobinder", "DefendNecrobinder", "Bodyguard", "Unleash"], "pool": ["PullAggro", "Afterlife", "Reanimate", "Spur", "Fetch"]},
    Defect: {"name": "故障机器人", "relic": "破损核心", "starter": ["StrikeDefect", "StrikeDefect", "StrikeDefect", "StrikeDefect", "DefendDefect", "DefendDefect", "DefendDefect", "DefendDefect", "Zap", "Dualcast"], "pool": ["BallLightning", "BeamCell", "ColdSnap", "GoForTheEyes", "Leap", "Skim"]},
};
const GAME_CARDS = {
    BodySlam: ["全身撞击", 1, "Attack", "造成等于自身当前格挡的伤害。"],
    Stomp: ["踩踏", 3, "Attack", "造成12点伤害。本回合此前每打出一张攻击牌，费用降低1点，最低为0。"],
    Pinpoint: ["精密瞄准", 3, "Attack", "造成15点伤害。本回合此前每打出一张技能牌，费用降低1点，最低为0。"],
    LunarBlast: ["月面射击", 0, "Attack", "本回合此前每打出一张技能牌，就造成一次4点伤害。"],
    Fetch: ["取回", 0, "Attack", "奥斯提造成3点伤害。同一张牌本回合首次打出时抽1张牌。"],
    PommelStrike: ["剑柄打击", 1, "Attack", "造成9点伤害。抽1张牌。"],
    TwinStrike: ["双重打击", 1, "Attack", "造成5点伤害两次。"],
    Backflip: ["后空翻", 1, "Skill", "获得5点格挡。抽2张牌。"],
    Adrenaline: ["肾上腺素", 0, "Skill", "获得1点能量。抽2张牌。消耗。"],
    Afterlife: ["来生", 1, "Skill", "召唤6。消耗。"],
    Reanimate: ["死者苏生", 3, "Skill", "召唤20。消耗。"],
    Spur: ["增生", 1, "Skill", "召唤3。奥斯提回复5点生命。保留。"],
    Skim: ["快速检索", 1, "Skill", "抽3张牌。"],
    StrikeIronclad: ["打击", 1, "Attack", "造成6点伤害。"],
    DefendIronclad: ["防御", 1, "Skill", "获得5点格挡。"],
    Bash: ["痛击", 2, "Attack", "造成8点伤害。 给予2层易伤。"],
    Bludgeon: ["重锤", 3, "Attack", "造成32点伤害。"],
    IronWave: ["铁斩波", 1, "Attack", "获得5点格挡。 造成5点伤害。"],
    Taunt: ["挑衅", 1, "Skill", "获得7点格挡。 给予1层易伤。"],
    StrikeSilent: ["打击", 1, "Attack", "造成6点伤害。"],
    DefendSilent: ["防御", 1, "Skill", "获得5点格挡。"],
    Neutralize: ["中和", 0, "Attack", "造成3点伤害。 给予1层虚弱。"],
    Survivor: ["生存者", 1, "Skill", "获得8点格挡。 丢弃1张牌。"],
    Dash: ["冲刺", 2, "Attack", "获得10点格挡。 造成10点伤害。"],
    Deflect: ["偏折", 0, "Skill", "获得4点格挡。"],
    LegSweep: ["扫腿", 2, "Skill", "给予2层虚弱。 获得11点格挡。"],
    Slice: ["切割", 0, "Attack", "造成6点伤害。"],
    SuckerPunch: ["突然一拳", 1, "Attack", "造成8点伤害。 给予1层虚弱。"],
    StrikeRegent: ["打击", 1, "Attack", "造成6点伤害。"],
    DefendRegent: ["防御", 1, "Skill", "获得5点格挡。"],
    FallingStar: ["陨星", 0, "Attack", "造成8点伤害。 给予1层虚弱。 给予1层易伤。", 2],
    Venerate: ["崇拜", 1, "Skill", "获得2颗星星。"],
    CloakOfStars: ["群星斗篷", 0, "Skill", "获得7点格挡。", 1],
    Comet: ["彗星", 0, "Attack", "造成33点伤害。 给予3层虚弱。 给予3层易伤。", 5],
    Devastate: ["葬送", 1, "Attack", "造成30点伤害。", 4],
    GammaBlast: ["伽马爆破", 0, "Attack", "造成13点伤害。 给予2层虚弱。 给予2层易伤。", 3],
    StrikeNecrobinder: ["打击", 1, "Attack", "造成6点伤害。"],
    DefendNecrobinder: ["防御", 1, "Skill", "获得5点格挡。"],
    Bodyguard: ["护卫", 1, "Skill", "召唤5。"],
    Unleash: ["出击", 1, "Attack", "奥斯提出击，伤害随其当前生命值增加。"],
    PullAggro: ["吸引仇恨", 2, "Skill", "召唤4。获得7点格挡。"],
    StrikeDefect: ["打击", 1, "Attack", "造成6点伤害。"],
    DefendDefect: ["防御", 1, "Skill", "获得5点格挡。"],
    Zap: ["电击", 1, "Skill", "生成1个闪电充能球。"],
    Dualcast: ["双重释放", 1, "Skill", "激发你最右侧的充能球两次。"],
    BallLightning: ["球状闪电", 1, "Attack", "造成7点伤害。生成1个闪电充能球。"],
    ColdSnap: ["寒流", 1, "Attack", "造成6点伤害。生成1个冰霜充能球。"],
    GoForTheEyes: ["眼部攻击", 0, "Attack", "造成3点伤害。若敌人意图攻击，给予1层虚弱。"],
    BeamCell: ["光束射线", 0, "Attack", "造成3点伤害。 给予1层易伤。"],
    Leap: ["飞跃", 1, "Skill", "获得9点格挡。"],
};
// Effects are applied in play order. Each hit is resolved against current block.
const DUEL_EFFECTS = {
    BodySlam: { hit: (actor) => actor.block },
    Stomp: { hit: 12, discount: "Attack" },
    Pinpoint: { hit: 15, discount: "Skill" },
    LunarBlast: { hit: 4, hits: (actor) => actor.played.Skill },
    Fetch: { hit: 3, osty: true, drawOnce: 1 },
    PommelStrike: { hit: 9, draw: 1 },
    TwinStrike: { hit: 5, hits: () => 2 },
    Backflip: { block: 5, draw: 2 },
    Adrenaline: { energy: 1, draw: 2, exhaust: true },
    Afterlife: { summon: 6, exhaust: true },
    Reanimate: { summon: 20, exhaust: true },
    Spur: { summon: 3, healOsty: 5, retain: true },
    Skim: { draw: 3 },
    Bash: { hit: 8, vulnerable: 2 },
    Bludgeon: { hit: 32 },
    IronWave: { block: 5, hit: 5 },
    Taunt: { block: 7, vulnerable: 1 },
    Neutralize: { hit: 3, weak: 1 },
    Survivor: { block: 8, discard: true },
    Dash: { block: 10, hit: 10 },
    Deflect: { block: 4 },
    LegSweep: { weak: 2, block: 11 },
    Slice: { hit: 6 },
    SuckerPunch: { hit: 8, weak: 1 },
    FallingStar: { hit: 8, weak: 1, vulnerable: 1 },
    Venerate: { stars: 2 },
    CloakOfStars: { block: 7 },
    Comet: { hit: 33, weak: 3, vulnerable: 3 },
    Devastate: { hit: 30 },
    GammaBlast: { hit: 13, weak: 2, vulnerable: 2 },
    Bodyguard: { summon: 5 },
    Unleash: { hit: (actor) => 6 + actor.osty, osty: true },
    PullAggro: { summon: 4, block: 7 },
    Zap: { orb: "lightning" },
    Dualcast: { evoke: true },
    BallLightning: { hit: 7, orb: "lightning" },
    ColdSnap: { hit: 6, orb: "frost" },
    GoForTheEyes: { hit: 3, weak: 1 },
    BeamCell: { hit: 3, vulnerable: 1 },
    Leap: { block: 9 },
};

function duelEffect(id) {
    if (id.startsWith("Strike")) return { hit: 6 };
    if (id.startsWith("Defend")) return { block: 5 };
    return DUEL_EFFECTS[id];
}

function duelFighter(player, random) {
    const deck = player.deck.map((id) => ({ id }));
    return {
        job: player.job, hp: 70, block: 0, weak: 0, vulnerable: 0,
        stars: player.job === "Regent" ? 3 : 0,
        osty: player.job === "Necrobinder" ? 1 : 0,
        ostyMax: player.job === "Necrobinder" ? 1 : 0,
        orbs: player.job === "Defect" ? ["lightning"] : [],
        deck: sample(random, deck, deck.length), discard: [], retained: [],
    };
}

function duelDraw(actor, hand, count, random) {
    for (let i = 0; i < count; i++) {
        if (!actor.deck.length) {
            actor.deck = sample(random, actor.discard, actor.discard.length);
            actor.discard = [];
        }
        if (!actor.deck.length) break;
        hand.push(actor.deck.pop());
    }
}

function duelDamage(actor, target, base, attack) {
    const scaled = attack ? base * (actor.weak ? 0.75 : 1) * (target.vulnerable ? 1.5 : 1) : base;
    let damage = Math.floor(scaled);
    const blocked = Math.min(target.block, damage);
    actor.turnDamage += damage;
    actor.turnBlocked += blocked;
    target.block -= blocked;
    damage -= blocked;
    const absorbed = Math.min(target.osty, damage);
    target.osty -= absorbed;
    if (!target.osty) target.ostyMax = 0;
    target.hp = Math.max(0, target.hp - (damage - absorbed));
}

function duelOrb(actor, target, orb, evoke) {
    if (orb === "frost") actor.block += evoke ? 5 : 2;
    if (orb === "lightning") duelDamage(actor, target, evoke ? 8 : 3, false);
}

function duelTurn(actor, target, round, random) {
    const hand = actor.retained;
    actor.retained = [];
    actor.block = 0;
    actor.played = { Attack: 0, Skill: 0 };
    actor.turnDamage = 0;
    actor.turnBlocked = 0;
    const playedInstances = new Set();
    const skipped = [];
    const names = [];
    let energy = 3;
    const openingStart = hand.length;
    duelDraw(actor, hand, round === 1 || round === 2
        ? (actor.job === "Silent" ? 7 : 5) : 5, random);
    const openingDraw = hand.slice(openingStart).map((card) => GAME_CARDS[card.id][0]);
    const extraDraw = [];
    for (let i = 0; i < hand.length && target.hp > 0; i++) {
        const card = hand[i];
        const [name, baseCost, type, , starCost = 0] = GAME_CARDS[card.id];
        const effect = duelEffect(card.id);
        const cost = Math.max(0, baseCost - (actor.played[effect.discount] ?? 0));
        if (cost > energy || starCost > actor.stars
            || (effect.osty && !actor.osty) || (effect.evoke && !actor.orbs.length)) {
            skipped.push(card);
            continue;
        }
        energy -= cost;
        actor.stars -= starCost;
        names.push(name);
        actor.block += effect.block ?? 0;
        const hit = typeof effect.hit === "function" ? effect.hit(actor) : effect.hit;
        for (let n = 0; hit && n < (effect.hits?.(actor) ?? 1) && target.hp > 0; n++) {
            duelDamage(actor, target, hit, true);
        }
        target.weak += effect.weak ?? 0;
        target.vulnerable += effect.vulnerable ?? 0;
        actor.stars += effect.stars ?? 0;
        actor.ostyMax += effect.summon ?? 0;
        actor.osty = Math.min(actor.ostyMax, actor.osty + (effect.summon ?? 0) + (effect.healOsty ?? 0));
        if (effect.orb) {
            if (actor.orbs.length === 3) duelOrb(actor, target, actor.orbs.shift(), true);
            actor.orbs.push(effect.orb);
        }
        if (effect.evoke) {
            const orb = actor.orbs.pop();
            duelOrb(actor, target, orb, true);
            duelOrb(actor, target, orb, true);
        }
        if (effect.discard && i + 1 < hand.length) actor.discard.push(hand.splice(i + 1, 1)[0]);
        energy += effect.energy ?? 0;
        const draw = effect.draw ?? (playedInstances.has(card) ? 0 : effect.drawOnce ?? 0);
        const drawStart = hand.length;
        duelDraw(actor, hand, draw, random);
        for (let j = drawStart; j < hand.length; j++) extraDraw.push(GAME_CARDS[hand[j].id][0]);
        playedInstances.add(card);
        actor.played[type]++;
        if (!effect.exhaust) actor.discard.push(card);
    }
    for (const card of skipped) {
        if (duelEffect(card.id).retain) actor.retained.push(card);
        else actor.discard.push(card);
    }
    const damage = actor.turnDamage;
    const blocked = actor.turnBlocked;
    const triggered = target.hp ? actor.orbs.slice() : [];
    for (const orb of triggered) duelOrb(actor, target, orb, false);
    actor.weak = Math.max(0, actor.weak - 1);
    actor.vulnerable = Math.max(0, actor.vulnerable - 1);
    return {
        cards: names, openingDraw, extraDraw, damage, blocked, triggered,
        orbDamage: actor.turnDamage - damage, orbBlocked: actor.turnBlocked - blocked,
    };
}

const DUEL_ROUNDS = 6;
const duelReports = new Map();
const DUEL_REPORT_LIMIT = 100;

function simulateDuel(firstPlayer, secondPlayer, random) {
    const fighters = [duelFighter(firstPlayer, random), duelFighter(secondPlayer, random)];
    const turns = [];
    for (let round = 1; round <= DUEL_ROUNDS; round++) {
        const side = (round - 1) % 2;
        const actor = fighters[side];
        const target = fighters[1 - side];
        if (!actor.hp || !target.hp) break;
        const play = duelTurn(actor, target, round, random);
        turns.push({
            round, side, ...play,
            block: actor.block,
            hp: fighters.map((fighter) => fighter.hp),
        });
    }
    return { hp: fighters.map((fighter) => fighter.hp), turns };
}

function duelGroup(ctx) {
    return String(ctx?.message?.groupOpenid ?? "");
}

function duelTarget(ctx) {
    // The SDK strips mention markers from command.raw but preserves message.content.
    const content = String(ctx?.message?.content ?? "");
    const match = /^\s*(?:<@!?[^>]+>\s*)*\/对战\s+<@!?([^>\s]+)>\s*$/u.exec(content);
    return match?.[1];
}

const REMOVE_BASE = 75;
const REMOVE_STEP = 25;
const OFFER_TTL_MS = 10 * 60 * 1000;
const OFFER_SIZE = 3;

function loadPlayers() {
    try {
        const obj = JSON.parse(readFileSync(PLAYER_FILE, "utf8"));
        return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {};
    } catch {
        return {};
    }
}
function savePlayers(obj) {
    try {
        writeFileSync(PLAYER_FILE, JSON.stringify(obj), "utf8");
    } catch {}
}
function getPlayer(store, id) {
    let p = store[id];
    if (!p || typeof p !== "object") {
        p = {};
        store[id] = p;
    }
    if (typeof p.gold !== "number") p.gold = 0;
    if (!Object.hasOwn(JOBS, p.job)) {
        if (Array.isArray(p.deck) && p.deck.length) p.previousDeck = p.deck.slice();
        p.job = "Defect";
        p.deck = JOBS.Defect.starter.slice();
        p.offer = null;
    }
    if (!Array.isArray(p.deck) || !p.deck.length) p.deck = JOBS[p.job].starter.slice();
    if (typeof p.removePrice !== "number") p.removePrice = REMOVE_BASE;
    if (p.lastSign === undefined) p.lastSign = null;
    if (p.offer === undefined) p.offer = null;
    return p;
}
function deckSummary(deck) {
    const m = new Map();
    for (const c of deck) m.set(c, (m.get(c) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
function offerLine(id, index) {
    const [name, energy, type, effect, stars] = GAME_CARDS[id];
    const cost = stars ? `${energy} 能量 + ${stars} 星星` : `${energy} 能量`;
    return `${index + 1}. ${name}（${cost} · ${type === "Attack" ? "攻击" : "技能"}）${effect}`;
}
function fortune(id, day) {
    return pick(rng(`f|${id}|${day}`), FORTUNES);
}
const chargeState = new Map(); // key -> {count, ts}

const HELP_PUBLIC = [
    "【指令表】群里直接发，不用 @",
    "",
    "▍尖塔",
    "/签到 —— 每天 50~100 金币",
    "/牌组 —— 看自己的牌组和金币",
    "/职业 —— 查看职业，或发 /职业 职业名 首次选定职业",
    "/抽卡 —— 从本职业卡池抽至多三张（/抽卡 跳过 放弃）",
    "/删卡 —— 花金币删一张牌（75 起，每删一次 +25）",
    "/遗物 —— 查看职业初始遗物",
    "/参战 [关闭] —— 开关本群被挑战权限",
    "/对战 @群友 —— 自动结算六回合",
    "/战报 [编号] —— 查看本群对战详情",
    "",
    "▍别的",
    "/扔 一句话 —— 匿名扔个漂流瓶",
    "/捞 —— 捞一个漂流瓶",
    "",
    "▍查自己",
    "/bot-me —— 我的 OpenID",
    "/bot-ping —— 网络延迟",
    "/bot-version —— 版本号",
    "/help —— 这张表",
    "",
    "▍闲聊",
    "叫「鸡煲」会应你；其余按概率插嘴，回的都是「XX了」",
].join("\n");

const HELP_ADMIN = [
    "",
    "▍管理员",
    "/new —— 开新会话（清空上下文）",
    "/compact —— 压缩会话历史",
    "/stop —— 中止当前生成",
    "/bot-status —— 会话状态",
    "/model —— 查看 / 切换模型",
    "/preset —— 查看 / 切换 preset",
].join("\n");

export function toysCommands() {
    return [
        {
            name: ["签到", "打卡", "checkin", "daily"],
            category: "toys",
            scope: "all",
            description: "每天签到：随机 50~100 金币",
            handler: (ctx) => {
                const store = loadPlayers();
                const id = uid(ctx);
                const p = getPlayer(store, id);
                const day = today();
                if (p.lastSign === day) {
                    return [
                        `【签到】今天已经签过了，明天再来。`,
                        `金币 ${p.gold} · 牌组 ${p.deck.length} 张`,
                    ].join("\n");
                }
                const gain = 50 + Math.floor(Math.random() * 51);
                p.gold += gain;
                p.lastSign = day;
                savePlayers(store);
                ctx.log?.info?.(`[climb] signin ${id} +${gain} gold=${p.gold}`);
                const lines = [`【签到】${who(ctx)} 获得 ${gain} 金币（余额 ${p.gold}）`];
                lines.push("发 /抽卡 查看本职业可选牌。");
                return lines.join("\n");
            },
        },
        {
            name: ["职业"],
            category: "toys",
            scope: "all",
            description: "查看或首次选定职业",
            handler: (ctx) => {
                const store = loadPlayers();
                const p = getPlayer(store, uid(ctx));
                const raw = String(ctx?.command?.raw ?? "").trim();
                const current = JOBS[p.job].name;
                const choices = Object.values(JOBS).map((job) => job.name).join("、");
                if (!raw) return `【职业】当前：${current}。可选：${choices}。首次改选会换用该职业初始牌组。`;
                const chosen = Object.keys(JOBS).find((id) => JOBS[id].name === raw);
                if (!chosen) return `可选职业：${choices}。`;
                if (p.jobSelected) return `职业已选定为${current}。`;
                if (chosen !== p.job) {
                    p.previousJobDeck = p.deck.slice();
                    p.job = chosen;
                    p.deck = JOBS[chosen].starter.slice();
                    p.offer = null;
                }
                p.jobSelected = true;
                savePlayers(store);
                return `【职业】已选定${raw}｜初始遗物：${JOBS[chosen].relic}`;
            },
        },
        {
            name: ["牌组", "deck", "我的牌组", "看牌组"],
            category: "toys",
            scope: "all",
            description: "查看当前牌组和金币",
            handler: (ctx) => {
                const store = loadPlayers();
                const p = getPlayer(store, uid(ctx));
                const lines = [`【牌组】${who(ctx)}　${JOBS[p.job].name} · 共 ${p.deck.length} 张 · 金币 ${p.gold}`];
                for (const [c, n] of deckSummary(p.deck)) lines.push(`· ${GAME_CARDS[c][0]} ×${n}`);
                lines.push(`删一张牌 ${p.removePrice} 金币（发 /删卡 看序号）`);
                return lines.join("\n");
            },
        },
        {
            name: ["删卡", "删牌", "remove"],
            category: "toys",
            scope: "all",
            description: "花金币删掉牌组里的一张牌，例：/删卡 3",
            handler: (ctx) => {
                const store = loadPlayers();
                const p = getPlayer(store, uid(ctx));
                const raw = String(ctx?.command?.raw ?? "").trim();
                if (p.deck.length <= 1) return "牌组只剩最后一张了，删不动。";
                if (!raw) {
                    const lines = [
                        `【删卡】需要 ${p.removePrice} 金币（当前 ${p.gold}）`,
                        "回复 /删卡 序号 删掉对应那张：",
                    ];
                    p.deck.forEach((c, i) => lines.push(offerLine(c, i)));
                    return lines.join("\n");
                }
                const idx = Number(raw.split(/\s+/)[0]);
                if (!Number.isInteger(idx) || idx < 1 || idx > p.deck.length) {
                    return `序号要在 1~${p.deck.length} 之间。`;
                }
                if (p.gold < p.removePrice) return `金币不够，还差 ${p.removePrice - p.gold}。`;
                const removed = p.deck.splice(idx - 1, 1)[0];
                const paid = p.removePrice;
                p.gold -= paid;
                p.removePrice += REMOVE_STEP;
                savePlayers(store);
                return `【删卡】删掉「${GAME_CARDS[removed][0]}」，花费 ${paid} 金币（余额 ${p.gold}）\n下次删卡：${p.removePrice} 金币`;
            },
        },
        {
            name: ["抽卡", "抽牌", "来张牌"],
            category: "toys",
            scope: "all",
            description: "从本职业卡池抽至多三张，选一张进牌组",
            handler: (ctx) => {
                const store = loadPlayers();
                const id = uid(ctx);
                const p = getPlayer(store, id);
                const raw = String(ctx?.command?.raw ?? "").trim();
                const offer = p.offer;
                const pool = JOBS[p.job].pool;
                const fresh = Boolean(
                    offer && Array.isArray(offer.cards) && offer.cards.length && offer.cards.every((id) => pool.includes(id)) && Date.now() - (offer.ts || 0) < OFFER_TTL_MS
                );

                if (!raw) {
                    if (fresh) {
                        const left = Math.max(1, Math.ceil((OFFER_TTL_MS - (Date.now() - offer.ts)) / 60000));
                        return [
                            `【抽卡】你有一组待选（还剩约 ${left} 分钟）：`,
                            ...offer.cards.map(offerLine),
                            `回复 /抽卡 序号（1～${offer.cards.length}），或 /抽卡 跳过`,
                        ].join("\n");
                    }
                    const r = rng(`offer|${id}|${Date.now()}|${Math.random()}`);
                    const cards = sample(r, pool, OFFER_SIZE);
                    p.offer = { cards, ts: Date.now() };
                    savePlayers(store);
                    return [
                        `【抽卡】${JOBS[p.job].name}｜${cards.length} 张可选`,
                        ...cards.map(offerLine),
                        `回复 /抽卡 序号（1～${cards.length}），或 /抽卡 跳过`,
                    ].join("\n");
                }
                if (raw === "跳过" || raw.toLowerCase() === "skip") {
                    if (!fresh) return "现在没有待选的牌。";
                    p.offer = null;
                    savePlayers(store);
                    return "【抽卡】已跳过，牌组没变。";
                }
                if (!fresh) return "没有待选的牌，先发 /抽卡。";
                const idx = Number(raw.split(/\s+/)[0]);
                if (!Number.isInteger(idx) || idx < 1 || idx > offer.cards.length) {
                    return `选 1~${offer.cards.length}，或发「/抽卡 跳过」。`;
                }
                const got = offer.cards[idx - 1];
                p.deck.push(got);
                p.offer = null;
                savePlayers(store);
                return `【抽卡】「${GAME_CARDS[got][0]}」加入牌组，现在共 ${p.deck.length} 张。`;
            },
        },
        {
            name: ["参战"],
            category: "toys",
            scope: "all",
            description: "开启或关闭本群的自动对战",
            handler(ctx) {
                const group = duelGroup(ctx);
                if (!group) return "请在群里使用 /参战。";
                const id = uid(ctx);
                const raw = String(ctx?.command?.raw ?? "").trim();
                if (raw && raw !== "关闭") return "用法：/参战 或 /参战 关闭。";
                const store = loadPlayers();
                const player = getPlayer(store, id);
                player.duelGroups ??= {};
                const groupKey = JSON.stringify(group);
                if (raw === "关闭") {
                    player.duelGroups[groupKey] = false;
                    savePlayers(store);
                    return "已关闭本群对战。";
                }
                player.duelGroups[groupKey] = who(ctx);
                savePlayers(store);
                return "已开启本群对战｜关闭请用 /参战 关闭";
            },
        },
        {
            name: ["对战"],
            category: "toys",
            scope: "all",
            description: "@本群成员发起六回合对战",
            async handler(ctx) {
                const group = duelGroup(ctx);
                if (!group) return "请在群里使用 /对战。";
                const otherId = duelTarget(ctx);
                if (!otherId) return "用法：/对战 @一位群友。请从群成员列表选择对方。";
                const id = uid(ctx);
                if (otherId === id) return "不能挑战自己。";
                const store = loadPlayers();
                const groupKey = JSON.stringify(group);
                const other = Object.hasOwn(store, otherId) ? store[otherId] : null;
                if (!other) return "这个 @ 没匹配到小游戏存档。请对方先用一次 /签到。";
                if (other.duelGroups?.[groupKey] === false) return "对方已关闭本群对战。";
                const player = getPlayer(store, id);
                const first = getPlayer(store, otherId);
                const day = today();
                const matchKey = JSON.stringify([group, otherId]);
                const reverseKey = JSON.stringify([group, id]);
                const testing = isAdmin(ctx, ctx?.log);
                if (!testing && (player.duelDays?.[matchKey] === day || first.duelDays?.[reverseKey] === day)) {
                    return "今天你们已经对战过了。";
                }
                const { hp, turns } = simulateDuel(player, first, Math.random);
                if (!testing) {
                    player.duelDays ??= {};
                    for (const key of Object.keys(player.duelDays)) {
                        if (player.duelDays[key] !== day) delete player.duelDays[key];
                    }
                    player.duelDays[matchKey] = day;
                    savePlayers(store);
                }
                const names = [who(ctx), other.duelGroups?.[groupKey] || "被挑战者"].map((name) =>
                    String(name).replace(/[\r\n]/g, " ").slice(0, 30));
                const result = hp[0] === hp[1] ? "平局" : `${names[hp[0] > hp[1] ? 0 : 1]}获胜`;
                const report = turns.map((turn) => {
                    const side = turn.side === 0 ? "先手" : "后手";
                    const cards = turn.cards.slice(0, 12).join(" → ") || "无出牌";
                    const extra = turn.cards.length > 12 ? ` 等${turn.cards.length}张` : "";
                    const opening = turn.openingDraw.join("、") || "无";
                    const extraCards = turn.extraDraw.slice(0, 12).join("、");
                    const extraCount = turn.extraDraw.length > 12 ? ` 等${turn.extraDraw.length}张` : "";
                    const bonus = extraCards ? `｜额外抽牌 ${extraCards}${extraCount}` : "";
                    const orbCounts = [
                        ["电球", turn.triggered.filter((orb) => orb === "lightning").length],
                        ["冰球", turn.triggered.filter((orb) => orb === "frost").length],
                    ];
                    const triggered = orbCounts.filter(([, count]) => count)
                        .map(([name, count]) => `${count}个${name}`).join("、");
                    const trigger = triggered ? `触发${triggered}` : "无球触发";
                    return [
                        `${turn.round}. ${side}｜抽牌：${opening}${bonus}`,
                        `   出牌：${cards}${extra}｜共造成${turn.damage}点伤害${turn.blocked > 0 ? `（${turn.blocked}点被格挡）` : ""}`,
                        `   回合结束：${trigger}｜共造成${turn.orbDamage}点伤害${turn.orbBlocked > 0 ? `（${turn.orbBlocked}点被格挡）` : ""} · 剩余${turn.block}点格挡｜HP ${turn.hp.join(":")}`,
                    ].join("\n");
                });
                if (turns.length < DUEL_ROUNDS) report.push("一方生命归零，余下回合跳过。");
                const title = `【六回合对战】${names[0]}（先手） vs ${names[1]}（后手）`;
                const score = `${hp.join(":")}｜${result}`;
                const reportId = randomUUID().replace(/-/g, "").slice(0, 12);
                duelReports.set(reportId, { group, text: [title, ...report, `【结算】${score}`].join("\n") });
                if (duelReports.size > DUEL_REPORT_LIMIT) duelReports.delete(duelReports.keys().next().value);
                const command = `/战报 ${reportId}`;
                const summary = `${title}\n${score}\n详情：${command}`;
                if (typeof ctx.bot?.sendTextWithKeyboard === "function") {
                    try {
                        await ctx.bot.sendTextWithKeyboard(ctx.replyTarget, summary, {
                            content: { rows: [{ buttons: [{
                                id: "duel-report",
                                render_data: { label: "查看战报", visited_label: "查看战报", style: 1 },
                                action: { type: 2, permission: { type: 2 }, data: command, enter: true },
                            }] }] },
                        });
                        return;
                    } catch (error) {
                        ctx.log?.warn?.(`[toys] duel keyboard unavailable: ${error?.bizCode ?? "unknown"}`);
                    }
                }
                return summary;
            },
        },
        {
            name: ["战报"],
            category: "toys",
            scope: "all",
            description: "查看本群已结算的对战详情",
            handler(ctx) {
                const group = duelGroup(ctx);
                if (!group) return "请在群里使用 /战报。";
                const id = String(ctx?.command?.raw ?? "").trim();
                if (id) {
                    const report = duelReports.get(id);
                    return report?.group === group ? report.text : "本群没有这份战报，或战报已过期。";
                }
                const latest = [...duelReports.values()].findLast((report) => report.group === group);
                return latest?.text ?? "本群暂无可查看的战报。";
            },
        },
        {
            name: ["遗物", "抽遗物", "今日遗物"],
            category: "toys",
            scope: "all",
            description: "查看职业初始遗物",
            handler: (ctx) => {
                const p = getPlayer(loadPlayers(), uid(ctx));
                const job = JOBS[p.job];
                return `【遗物】${job.name}｜${job.relic}`;
            },
        },
        {
            name: ["扔", "投递", "扔瓶子"],
            category: "toys",
            scope: "all",
            description: "匿名扔一个漂流瓶，例：/扔 今天好累",
            handler: (ctx) => {
                const raw = String(ctx?.command?.raw ?? "").trim();
                if (!raw) {
                    return "用法：/扔 一句话\n（内容会匿名存起来，别人 /捞 能捞到）";
                }
                const text = raw.slice(0, 200);
                const store = loadBottles();
                store.push({ t: text, ts: Date.now() });
                if (store.length > BOTTLE_MAX) store.splice(0, store.length - BOTTLE_MAX);
                saveBottles(store);
                ctx.log?.info?.(`[toys] bottle thrown len=${text.length} total=${store.length}`);
                return "已匿名投递漂流瓶。";
            },
        },
        {
            name: ["捞", "捞瓶子", "捡瓶子"],
            category: "toys",
            scope: "all",
            description: "从海里捞一个匿名漂流瓶",
            handler: (ctx) => {
                const store = loadBottles();
                if (store.length === 0) return "你在海上漂了半天，一个瓶子都没捞到。";
                const b = store[Math.floor(Math.random() * store.length)];
                return `你捞到一个匿名漂流瓶：\n${b.t}`;
            },
        },
        {
            name: ["help", "帮助", "指令", "用法", "菜单"],
            category: "toys",
            scope: "all",
            description: "查看全部指令和用法",
            handler: (ctx) => {
                const admin = isAdmin(ctx, ctx?.log);
                return admin ? `${HELP_PUBLIC}\n${HELP_ADMIN}` : HELP_PUBLIC;
            },
        },
    ];
}

export const TOYS_STATS = { cards: CARDS.length, relics: RELICS.length };
