import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { nativeDuelEnabled, sendNativeDuel } from "./native_duel.js";
import { sendCardOffer, sendDeckPage } from "./card_offer_image.js";
// Expanded 0.111.1 pool: 79 non-starter cards/job. Deploy with the matching
// QQBotEnemyTest.dll and legacy-card-pool.json; updating this file alone is unsafe.
/**
 * 故障机器人小玩具（dsh-qqbot 命令扩展）
 *   /抽卡   /遗物   /扔   /捞   /help
 *
 * 与 AstrBot 版 astrbot_plugin_defect_toys 行为一致：
 *   - 抽卡/遗物按「用户 + 当天日期」确定性随机（同一天问两次结果相同）
 *   - /help 里的管理员段落只对白名单用户显示
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
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
function today(d = new Date()) {
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
    Ironclad: {"name": "铁甲战士", "relic": "燃烧之血", "starter": ["StrikeIronclad", "StrikeIronclad", "StrikeIronclad", "StrikeIronclad", "StrikeIronclad", "DefendIronclad", "DefendIronclad", "DefendIronclad", "DefendIronclad", "Bash"], "pool": ["Bludgeon", "IronWave", "Taunt", "PommelStrike", "TwinStrike", "BodySlam", "Stomp", "ShrugItOff", "Thunderclap", "Conflagration", "Impervious", "Tremble", "Inflame", "Uppercut", "Headbutt", "Anger", "AshenStrike", "Barricade", "BattleTrance", "BloodWall", "Bloodletting", "Breakthrough", "DemonForm", "Dismantle", "Hemokinesis", "MoltenFist", "Offering", "Pyre", "SwordBoomerang", "Brand", "BurningPact", "TrueGrit", "FeelNoPain", "DarkEmbrace", "EvilEye", "ForgottenRitual", "Cinder", "PactsEnd", "SecondWind", "Bully", "CrimsonMantle", "Cruelty", "Dominate", "DrumOfBattle", "Mangle", "NotYet", "SetupStrike", "Unrelenting", "Whirlwind", "Rampage", "Aggression", "Armaments", "Cascade", "Colossus", "ExpectAFight", "FiendFire", "FightMe", "FlameBarrier", "Havoc", "Hellraiser", "HowlFromBeyond", "InfernalBlade", "Inferno", "Juggernaut", "Juggling", "OneTwoPunch", "PerfectedStrike", "Pillage", "PrimalForce", "Rage", "Rupture", "Spite", "Stampede", "Stoke", "StoneArmor", "TearAsunder", "Thrash", "Unmovable", "Vicious"]},
    Silent: {"name": "静默猎手", "relic": "蛇之戒指", "starter": ["StrikeSilent", "StrikeSilent", "StrikeSilent", "StrikeSilent", "StrikeSilent", "DefendSilent", "DefendSilent", "DefendSilent", "DefendSilent", "DefendSilent", "Neutralize", "Survivor"], "pool": ["Dash", "Deflect", "LegSweep", "Slice", "SuckerPunch", "Backflip", "Adrenaline", "Pinpoint", "DaggerSpray", "DaggerThrow", "Acrobatics", "Footwork", "BladeDance", "CloakAndDagger", "Accuracy", "InfiniteBlades", "Backstab", "DodgeAndRoll", "DeadlyPoison", "PoisonedStab", "BouncingFlask", "NoxiousFumes", "Afterimage", "Assassinate", "BubbleBubble", "Finisher", "LeadingStrike", "Predator", "Snakebite", "Mirage", "Pounce", "Prepared", "Ricochet", "Untouchable", "UpMySleeve", "Haze", "FlickFlack", "Anticipate", "Tracking", "Abrasive", "Accelerant", "Blur", "Envenom", "GrandFinale", "MementoMori", "Murder", "PiercingWail", "Shadowmeld", "Skewer", "Flechettes", "BladeOfInk", "BulletTime", "Burst", "CalculatedGamble", "CorrosiveWave", "EchoingSlash", "EscapePlan", "Expertise", "Expose", "FanOfKnives", "HandTrick", "HiddenDaggers", "KnifeTrap", "Malaise", "MasterPlanner", "Nightmare", "Outbreak", "PhantomBlades", "PreciseCut", "Reflex", "SerpentForm", "ShadowStep", "Sidestep", "Speedster", "StormOfSteel", "Strangle", "Tactician", "ToolsOfTheTrade", "WellLaidPlans"]},
    Regent: {"name": "储君", "relic": "天赋君权", "starter": ["StrikeRegent", "StrikeRegent", "StrikeRegent", "StrikeRegent", "DefendRegent", "DefendRegent", "DefendRegent", "DefendRegent", "FallingStar", "Venerate"], "pool": ["CloakOfStars", "Comet", "Devastate", "GammaBlast", "LunarBlast", "GatherLight", "SolarStrike", "Alignment", "AstralPulse", "CelestialMight", "GuidingStar", "KnowThyPlace", "Prophesize", "RoyalGamble", "SevenStars", "Genesis", "HiddenCache", "Glow", "ShiningStrike", "CollisionCourse", "CosmicIndifference", "CrescentSpear", "CrushUnder", "DyingStar", "Glitterstream", "Hegemony", "KinglyKick", "KinglyPunch", "Resonance", "Bulwark", "BigBang", "Furnace", "RefineBlade", "SpoilsOfBattle", "TheSmith", "WroughtInWar", "Patter", "Terraforming", "BlackHole", "ChildOfTheStars", "Convergence", "CrashLanding", "Monologue", "NeutronAegis", "Parry", "Radiate", "SeekingEdge", "Stardust", "PhotonCut", "Conqueror", "Arsenal", "BeatIntoShape", "Begone", "Bombardment", "BundleOfJoy", "Charge", "DecisionsDecisions", "ForegoneConclusion", "Glimmer", "Guards", "HeavenlyDrill", "HeirloomHammer", "IAmInvincible", "KnockoutBlow", "MakeItSo", "ManifestAuthority", "MonarchsGaze", "Orbit", "PaleBlueDot", "ParticleWall", "PillarOfCreation", "Quasar", "Reflect", "SpectrumShift", "SummonForth", "Supermassive", "SwordSage", "Tyranny", "VoidForm"]},
    Necrobinder: {"name": "亡灵契约师", "relic": "缚魂命匣", "starter": ["StrikeNecrobinder", "StrikeNecrobinder", "StrikeNecrobinder", "StrikeNecrobinder", "DefendNecrobinder", "DefendNecrobinder", "DefendNecrobinder", "DefendNecrobinder", "Bodyguard", "Unleash"], "pool": ["PullAggro", "Afterlife", "Reanimate", "Spur", "Fetch", "Poke", "HighFive", "Reap", "Sow", "Wisp", "Calcify", "Reave", "GraveWarden", "SoulStorm", "Flatten", "BoneShards", "Scourge", "NegativePulse", "Deathbringer", "BlightStrike", "Bury", "CaptureSpirit", "Countdown", "Defile", "Defy", "Delay", "Demesne", "Fear", "Putrefy", "TimesUp", "Cleanse", "DeathsDoor", "Dredge", "Eradicate", "Graveblast", "Invoke", "NoEscape", "Oblivion", "Seance", "Severance", "BorrowedTime", "DeathMarch", "DevourLife", "Dirge", "EnfeeblingTouch", "Friendship", "Haunt", "Parse", "Rattle", "Undeath", "BansheesCry", "CallOfTheVoid", "DanseMacabre", "Debilitate", "DrainPower", "Eidolon", "EndOfDays", "Hang", "Lethality", "Melancholy", "Misery", "NecroMastery", "Neurosurge", "Pagestorm", "PullFromBelow", "ReaperForm", "RightHandHand", "Sacrifice", "SculptingStrike", "SentryMode", "SharedFate", "Shroud", "SicEm", "SleightOfFlesh", "Snap", "SpiritOfAsh", "Squeeze", "Transfigure", "Veilpiercer"]},
    Defect: {"name": "故障机器人", "relic": "破损核心", "starter": ["StrikeDefect", "StrikeDefect", "StrikeDefect", "StrikeDefect", "DefendDefect", "DefendDefect", "DefendDefect", "DefendDefect", "Zap", "Dualcast"], "pool": ["BallLightning", "BeamCell", "ColdSnap", "GoForTheEyes", "Leap", "Skim", "CompileDriver", "SweepingBeam", "Coolheaded", "Supercritical", "Capacitor", "BoostAway", "BootSequence", "Ftl", "Turbo", "Darkness", "ShadowShield", "Barrage", "ChargeBattery", "Chill", "Claw", "DoubleEnergy", "Glacier", "Hologram", "IceLance", "MachineLearning", "Null", "Rainbow", "Synthesis", "Defragment", "Hotfix", "FocusedStrike", "Hyperbeam", "Synchronize", "FightThrough", "Overclock", "Hailstorm", "LightningRod", "TeslaCoil", "BulkUp", "Buffer", "Coolant", "Fusion", "Glasswork", "Loop", "Modded", "MomentumStrike", "MultiCast", "Tempest", "Refract", "AdaptiveStrike", "AllForOne", "Chaos", "Compact", "ConsumingShadow", "CreativeAi", "EchoForm", "Feral", "FlakCannon", "GunkUp", "HelixDrill", "Iteration", "MeteorStrike", "Reboot", "RocketPunch", "Scavenge", "Scrape", "Shatter", "SignalBoost", "Smokestack", "Spinner", "Storm", "Subroutine", "Sunder", "Thunder", "TrashToTreasure", "Uproar", "Voltaic", "WhiteNoise"]},
};
const GAME_CARDS = {
    Aggression: ["好勇斗狠", 1, "Power", "在你的回合开始时，将你弃牌堆的一张随机攻击牌放入你的手牌并将其升级。", 0],
    Anger: ["愤怒", 0, "Attack", "造成6点伤害。 将一张此牌的复制品加入你的弃牌堆。", 0],
    Armaments: ["武装", 1, "Skill", "获得5点格挡。 升级你手牌中的一张牌。", 0],
    AshenStrike: ["灰烬打击", 1, "Attack", "造成6点伤害。 你的消耗牌堆中每有一张牌，伤害增加3。", 0],
    Barricade: ["壁垒", 3, "Power", "格挡不再在你的回合开始时消失。", 0],
    Bash: ["痛击", 2, "Attack", "造成8点伤害。 给予2层易伤。", 0],
    BattleTrance: ["战斗专注", 0, "Skill", "抽3张牌。 你在本回合内不能再抽任何牌。", 0],
    BloodWall: ["血墙", 2, "Skill", "失去2点生命。 获得16点格挡。", 0],
    Bloodletting: ["放血", 0, "Skill", "失去3点生命。 获得2点能量。", 0],
    Bludgeon: ["重锤", 3, "Attack", "造成32点伤害。", 0],
    BodySlam: ["全身撞击", 1, "Attack", "造成你当前格挡值的伤害。", 0],
    Brand: ["烙印", 0, "Skill", "失去1点生命。 消耗1张牌。 获得1点力量。", 0],
    Break: ["破击", 1, "Attack", "造成20点伤害。 给予5层易伤。", 0],
    Breakthrough: ["突破", 1, "Attack", "失去1点生命。 对所有敌人造成9点伤害。", 0],
    Bully: ["欺凌", 0, "Attack", "造成4点伤害。 该敌人身上每有一层易伤就额外造成2点伤害。", 0],
    BurningPact: ["燃烧契约", 1, "Skill", "消耗1张牌。 抽2张牌。", 0],
    Cascade: ["倾泻", -1, "Skill", "打出你抽牌堆顶部的X张牌。", 0],
    Cinder: ["余烬", 2, "Attack", "造成18点伤害。 随机消耗1张牌。", 0],
    Colossus: ["巨像", 1, "Skill", "获得4点格挡。 在本回合中，有易伤状态的敌人对你造成的伤害降低50%。", 0],
    Conflagration: ["焚烧", 1, "Attack", "对所有敌人造成2点伤害4次。", 0],
    Corruption: ["腐化", 3, "Power", "技能牌消耗变为01点能量。 每当你打出一张技能牌时，将其消耗。", 0],
    CrimsonMantle: ["绯红披风", 1, "Power", "在你的回合开始时，失去1点生命并获得7点格挡。", 0],
    Cruelty: ["残酷", 1, "Power", "有易伤状态的敌人额外受到25%的伤害。", 0],
    DarkEmbrace: ["黑暗之拥", 2, "Power", "每当有一张牌被消耗时， 抽1张牌。", 0],
    DefendIronclad: ["防御", 1, "Skill", "获得5点格挡。", 0],
    DemonForm: ["恶魔形态", 3, "Power", "在你的回合开始时，获得3点力量。", 0],
    Dismantle: ["拆卸", 1, "Attack", "造成8点伤害。 如果该敌人有易伤状态，则攻击两次。", 0],
    Dominate: ["主宰", 1, "Skill", "给予1层易伤。 敌人身上每有一层易伤，就获得1点力量。 消耗。", 0],
    DrumOfBattle: ["战鼓", 1, "Skill", "抽2张牌。 这张牌被消耗时，获得2点能量。", 0],
    EvilEye: ["邪眼", 1, "Skill", "获得8点格挡。 如果你在本回合消耗过卡牌，则额外获得8点格挡。", 0],
    ExpectAFight: ["跃跃欲试", 3, "Skill", "获得15点格挡。 你每拥有一点力量，这张牌就额外获得5点格挡。", 0],
    Feed: ["狂宴", 1, "Attack", "造成10点伤害。 斩杀时，永久获得3点最大生命值。 消耗。", 0],
    FeelNoPain: ["无惧疼痛", 1, "Power", "每当有一张牌被消耗时，获得3点格挡。", 0],
    FiendFire: ["恶魔之焰", 2, "Attack", "消耗所有手牌。 每张被消耗的牌造成7点伤害。 消耗。", 0],
    FightMe: ["与我一战！", 2, "Attack", "造成5点伤害两次。 获得3点力量。 该敌人获得1点力量。", 0],
    FlameBarrier: ["火焰屏障", 2, "Skill", "获得12点格挡。 你在这个回合每受到一次攻击，都会对攻击者造成4点伤害。", 0],
    ForgottenRitual: ["被遗忘的仪式", 1, "Skill", "获得3点能量。 消耗。", 0],
    Havoc: ["破灭", 1, "Skill", "打出抽牌堆顶部的牌并将其消耗。", 0],
    Headbutt: ["头槌", 1, "Attack", "造成9点伤害。 将你弃牌堆中的一张牌放到抽牌堆顶部。", 0],
    Hellraiser: ["地狱狂徒", 2, "Power", "每当你抽到名字中有“打击”的牌时，对一名随机敌人打出这张牌。", 0],
    Hemokinesis: ["御血术", 1, "Attack", "失去2点生命。 造成15点伤害。", 0],
    HowlFromBeyond: ["彼岸咆哮", 3, "Attack", "对所有敌人造成18点伤害。 在你的回合结束时，如果这张牌在你的消耗牌堆中，则将其打出。", 0],
    Impervious: ["岿然不动", 2, "Skill", "获得30点格挡。 消耗。", 0],
    InfernalBlade: ["地狱之刃", 1, "Skill", "将一张随机攻击牌加入你的手牌。那张牌在本回合内可以免费打出。 消耗。", 0],
    Inferno: ["狱火", 1, "Power", "在你的回合开始时，失去1点生命。 每当你在你的回合内失去生命时，对所有敌人造成6点伤害。", 0],
    Inflame: ["燃烧", 1, "Power", "获得2点力量。", 0],
    IronWave: ["铁斩波", 1, "Attack", "获得5点格挡。 造成5点伤害。", 0],
    Juggernaut: ["势不可当", 2, "Power", "每当你获得格挡时，对随机敌人造成6点伤害。", 0],
    Juggling: ["杂耍", 1, "Power", "将你在每回合打出的第三张攻击牌的复制品加入你的手牌。", 0],
    Mangle: ["凌虐", 3, "Attack", "造成20点伤害。 敌人在本回合失去10点力量。", 0],
    MoltenFist: ["熔融之拳", 1, "Attack", "造成10点伤害。 将该敌人身上的易伤层数翻倍。 消耗。", 0],
    NotYet: ["时候未到", 2, "Skill", "回复10点生命。 消耗。", 0],
    Offering: ["祭品", 0, "Skill", "失去6点生命。 获得2点能量。 抽3张牌。 消耗。", 0],
    OneTwoPunch: ["连环拳", 1, "Skill", "在这个回合，你打出的下1张攻击牌会被额外打出一次。", 0],
    PactsEnd: ["契约终结", 0, "Attack", "如果你的消耗牌堆拥有大于等于3张牌， 则对所有敌人造成18点伤害。", 0],
    PerfectedStrike: ["完美打击", 2, "Attack", "造成6点伤害。 你每有一张名字中含有“打击”的牌，伤害+2。", 0],
    Pillage: ["劫掠", 1, "Attack", "造成6点伤害。 抽牌直到你抽到一张非攻击牌。", 0],
    PommelStrike: ["剑柄打击", 1, "Attack", "造成9点伤害。 抽1张牌。", 0],
    PrimalForce: ["原始力量", 0, "Skill", "将手牌中的所有攻击牌变化为巨石。", 0],
    Pyre: ["薪火之源", 2, "Power", "在回合开始时，获得1点能量。", 0],
    Rage: ["狂怒", 0, "Skill", "打出此牌后，你在这个回合内每打出一张攻击牌，获得3点格挡。", 0],
    Rampage: ["暴走", 1, "Attack", "造成10点伤害。 将这张牌在本场战斗中的伤害增加5。", 0],
    Rupture: ["撕裂", 1, "Power", "每当你在你的回合失去生命值时, 获得1点力量。", 0],
    SecondWind: ["重振精神", 1, "Skill", "消耗手牌中所有非攻击牌，每张获得5点格挡。", 0],
    SetupStrike: ["预备打击", 1, "Attack", "造成7点伤害。 在本回合内获得3点力量。", 0],
    ShrugItOff: ["耸肩无视", 1, "Skill", "获得8点格挡。 抽1张牌。", 0],
    Spite: ["怨恨", 0, "Attack", "造成5点伤害。 如果你在本回合失去过生命值， 则攻击2次。", 0],
    Stampede: ["惊逃", 2, "Power", "在你的回合结束时，随机打出你手牌中的1张攻击牌攻击随机敌人。", 0],
    Stoke: ["添柴", 1, "Skill", "消耗所有手牌。 每消耗一张牌，将1张随机牌加入你的手牌。", 0],
    Stomp: ["踩踏", 3, "Attack", "对所有敌人造成12点伤害。 你在本回合中每打出过一张攻击牌，其耗能减少11点能量。", 0],
    StoneArmor: ["岩石铠甲", 1, "Power", "获得4层覆甲。", 0],
    StrikeIronclad: ["打击", 1, "Attack", "造成6点伤害。", 0],
    SwordBoomerang: ["飞剑回旋镖", 1, "Attack", "随机对敌人造成3点伤害3次。", 0],
    Taunt: ["挑衅", 1, "Skill", "获得6点格挡。 给予1层易伤。", 0],
    TearAsunder: ["扯碎", 2, "Attack", "造成5点伤害。 在本场战斗中，你每失去过一次生命值，这张牌就额外造成一次伤害。", 0],
    Thrash: ["痛殴", 1, "Attack", "造成4点伤害两次。 消耗你的手牌中随机一张攻击牌，并将它的伤害添加给这张牌。", 0],
    Thunderclap: ["闪电霹雳", 1, "Attack", "对所有敌人造成4点伤害，给予1层易伤。", 0],
    Tremble: ["战栗", 1, "Skill", "给予3层易伤。 消耗。", 0],
    TrueGrit: ["坚毅", 1, "Skill", "获得7点格挡。 随机消耗1张牌。", 0],
    TwinStrike: ["双重打击", 1, "Attack", "造成5点伤害两次。", 0],
    Unmovable: ["坚定不移", 2, "Power", "翻倍你每回合第一次从卡牌中获得的格挡。", 0],
    Unrelenting: ["无情猛攻", 2, "Attack", "造成14点伤害。 你打出的下一张攻击牌耗能变为01点能量。", 0],
    Uppercut: ["上勾拳", 2, "Attack", "造成13点伤害。 给予1层虚弱。 给予1层易伤。", 0],
    Vicious: ["凶恶", 1, "Power", "每当你给予易伤时，抽1张牌。", 0],
    Whirlwind: ["旋风斩", -1, "Attack", "对所有敌人造成5点伤害X次。", 0],
    Abrasive: ["磨蚀", 3, "Power", "奇巧。 获得1点敏捷。 获得4点荆棘。", 0],
    Accelerant: ["触媒", 1, "Power", "中毒会额外触发1次。", 0],
    Accuracy: ["精准", 1, "Power", "小刀额外造成4点伤害。", 0],
    Acrobatics: ["杂技", 1, "Skill", "抽3张牌。 丢弃1张牌。", 0],
    Adrenaline: ["肾上腺素", 0, "Skill", "获得1点能量。 抽2张牌。 消耗。", 0],
    Afterimage: ["余像", 1, "Power", "你每打出一张牌，都获得1点格挡。", 0],
    Anticipate: ["预判", 0, "Skill", "在本回合获得2点敏捷。", 0],
    Assassinate: ["刺杀", 0, "Attack", "固有。 造成10点伤害。 给予1层易伤。 消耗。", 0],
    Backflip: ["后空翻", 1, "Skill", "获得5点格挡。 抽2张牌。", 0],
    Backstab: ["背刺", 0, "Attack", "固有。 造成11点伤害。 消耗。", 0],
    BladeOfInk: ["墨之刃", 1, "Skill", "添加2张墨影小刀到你的手牌。", 0],
    BladeDance: ["刀刃之舞", 1, "Skill", "添加3张小刀到你的手牌。 消耗。", 0],
    Blur: ["残影", 1, "Skill", "获得5点格挡。 你的下一回合开始时格挡不会消失。", 0],
    BouncingFlask: ["弹跳药瓶", 2, "Skill", "随机给予敌人3层中毒3次。", 0],
    BubbleBubble: ["咕嘟冒泡", 1, "Skill", "如果敌方拥有中毒，则给予9层中毒。", 0],
    BulletTime: ["子弹时间", 3, "Skill", "你在本回合内不能再抽牌。你手牌中的所有牌在本回合免费打出。", 0],
    Burst: ["爆发", 1, "Skill", "在这个回合，你打出的下一张技能牌会被额外打出一次。", 0],
    CalculatedGamble: ["计算下注", 0, "Skill", "丢弃你的所有手牌, 然后抽相同数量的牌。 消耗。", 0],
    CloakAndDagger: ["斗篷与匕首", 1, "Skill", "获得6点格挡。 将1张小刀添加到你的手牌。", 0],
    CorrosiveWave: ["腐蚀波", 1, "Skill", "打出此牌后，你在本回合每抽到一张牌，就给予所有敌人2层中毒。", 0],
    DaggerSpray: ["匕首雨", 1, "Attack", "对所有敌人造成4点伤害两次。", 0],
    DaggerThrow: ["投掷匕首", 1, "Attack", "造成9点伤害。 抽1张牌。 丢弃1张牌。", 0],
    Dash: ["冲刺", 2, "Attack", "获得10点格挡。 造成10点伤害。", 0],
    DeadlyPoison: ["致命毒药", 1, "Skill", "给予5层中毒。", 0],
    DefendSilent: ["防御", 1, "Skill", "获得5点格挡。", 0],
    Deflect: ["偏折", 0, "Skill", "获得4点格挡。", 0],
    DodgeAndRoll: ["闪躲翻滚", 1, "Skill", "获得4点格挡。 在下个回合，获得4点格挡。", 0],
    EchoingSlash: ["回响斩击", 1, "Attack", "对所有敌人造成10点伤害。 每有一名敌人被击杀，就重复此效果。", 0],
    Envenom: ["涂毒", 2, "Power", "每有一次攻击造成未被格挡的伤害，就给予1层中毒。", 0],
    EscapePlan: ["逃脱计划", 0, "Skill", "抽1张牌。 如果抽到的是技能牌，则获得3点格挡。", 0],
    Expertise: ["独门技术", 1, "Skill", "抽2张牌。 这些牌在本回合获得保留。", 0],
    Expose: ["暴露", 0, "Skill", "去除敌人身上的所有格挡值和人工制品。 并给予2层易伤。 消耗。", 0],
    FanOfKnives: ["刀扇", 2, "Power", "小刀现在会攻击所有敌人。 将4张小刀添加到你的手牌。", 0],
    Finisher: ["终结技", 1, "Attack", "在这个回合内每打出过一张攻击牌，就造成6点伤害一次。", 0],
    Flechettes: ["飞镖", 1, "Attack", "手牌中每有一张技能牌，造成5点伤害。", 0],
    FlickFlack: ["翻越撑击", 1, "Attack", "奇巧。 对所有敌人造成7点伤害。", 0],
    Sidestep: ["侧步", 0, "Skill", "下回合，获得1点能量。", 0],
    Footwork: ["灵动步法", 1, "Power", "获得2点敏捷。", 0],
    GrandFinale: ["华丽收场", 0, "Attack", "只有当你的抽牌堆中没有牌时才能打出。对所有敌人造成60点伤害。", 0],
    HandTrick: ["手上技法", 1, "Skill", "获得7点格挡。 在本回合给你手牌中的一张技能牌添加奇巧。", 0],
    Haze: ["迷雾", 2, "Skill", "给予所有敌人4层中毒和1层虚弱。", 0],
    HiddenDaggers: ["隐秘匕首", 0, "Skill", "丢弃2张牌。 将2张小刀加入你的手牌。", 0],
    InfiniteBlades: ["无尽刀刃", 1, "Power", "在你的回合开始时，在你的手牌中加入1张小刀。", 0],
    KnifeTrap: ["刀刃陷阱", 2, "Skill", "将你消耗牌堆中的所有小刀对一名敌人打出。", 0],
    LeadingStrike: ["先制打击", 1, "Attack", "造成3点伤害。 将2张小刀加入你的手牌。", 0],
    LegSweep: ["扫腿", 2, "Skill", "给予2层虚弱。 获得11点格挡。", 0],
    Malaise: ["萎靡", -1, "Skill", "敌人失去X点力量。给予X层虚弱。 消耗。", 0],
    MasterPlanner: ["谋划专家", 2, "Power", "当你打出技能牌时，该牌获得奇巧。", 0],
    MementoMori: ["铭记死亡", 1, "Attack", "造成9点伤害。 本回合每丢弃过一张牌，则增加4点额外伤害。", 0],
    Mirage: ["蜃景", 1, "Skill", "获得等量于所有敌人中毒层数总和的格挡。 消耗。", 0],
    Murder: ["谋杀", 3, "Attack", "造成1点伤害。 你在本场战斗中每抽过一张牌，此牌就额外造成1点伤害。", 0],
    Neutralize: ["中和", 0, "Attack", "造成3点伤害。 给予1层虚弱。", 0],
    Nightmare: ["夜魇", 3, "Skill", "选择一张牌。 在下个回合将这张牌的3张复制品加入你的手牌。 消耗。", 0],
    NoxiousFumes: ["毒雾", 1, "Power", "在你的回合开始时，给予所有敌人2层中毒。", 0],
    Outbreak: ["毒性爆发", 3, "Skill", "给予所有敌人9层中毒。 立即触发中毒。", 0],
    PhantomBlades: ["幻影之刃", 1, "Power", "小刀获得保留。 你在每回合打出的第一张小刀额外造成9点伤害。", 0],
    PiercingWail: ["尖啸", 1, "Skill", "所有敌人在本回合失去6点力量。 消耗。", 0],
    Pinpoint: ["精密瞄准", 3, "Attack", "造成15点伤害。 你在本回合中每打出过一张技能牌，其耗能减少11点能量。", 0],
    PoisonedStab: ["带毒刺击", 1, "Attack", "造成6点伤害。 给予3层中毒。", 0],
    Pounce: ["猛扑", 2, "Attack", "造成14点伤害。 你的下一张技能牌耗能变为01点能量。", 0],
    PreciseCut: ["精确切击", 0, "Attack", "造成13点伤害。 你的手牌中每有一张牌，此牌的伤害就降低2点。", 0],
    Predator: ["猎杀者", 2, "Attack", "造成15点伤害。 在下个回合抽2张牌。", 0],
    Prepared: ["早有准备", 0, "Skill", "抽1张牌。 丢弃1张牌。", 0],
    Reflex: ["本能反应", 3, "Skill", "奇巧。 抽2张牌。", 0],
    Ricochet: ["连续反弹", 2, "Attack", "奇巧。 随机对敌人造成3点伤害4次。", 0],
    SerpentForm: ["群蛇形态", 3, "Power", "你每打出一张牌，就对随机一名敌人造成4点伤害。", 0],
    ShadowStep: ["暗影步", 1, "Skill", "丢弃所有手牌。 在下个回合，你所有的攻击伤害翻倍。", 0],
    Shadowmeld: ["融入暗影", 1, "Skill", "本回合你获得的格挡值翻倍。", 0],
    Skewer: ["串刺", -1, "Attack", "造成8点伤害X次。", 0],
    Slice: ["切割", 0, "Attack", "造成6点伤害。", 0],
    Snakebite: ["蛇咬", 2, "Skill", "保留。 给予7层中毒。", 0],
    Speedster: ["速行者", 2, "Power", "每当你在回合进行中抽到一张牌时，对所有敌人造成2点伤害。", 0],
    StormOfSteel: ["钢铁风暴", 1, "Skill", "丢弃所有手牌。 每丢弃一张牌，就将一张小刀添加至你的手牌。", 0],
    Strangle: ["紧勒", 1, "Attack", "造成8点伤害。 你在这个回合内每出一张牌，该名敌人都会失去2点生命。", 0],
    StrikeSilent: ["打击", 1, "Attack", "造成6点伤害。", 0],
    SuckerPunch: ["突然一拳", 1, "Attack", "造成8点伤害。 给予1层虚弱。", 0],
    Suppress: ["压制", 0, "Attack", "固有。 造成11点伤害。 给予3层虚弱。", 0],
    Survivor: ["生存者", 1, "Skill", "获得8点格挡。 丢弃1张牌。", 0],
    Tactician: ["战术大师", 3, "Skill", "奇巧。 获得1点能量。", 0],
    TheHunt: ["狩猎", 1, "Attack", "造成10点伤害。 斩杀时，额外获得一次卡牌奖励。 消耗。", 0],
    ToolsOfTheTrade: ["必备工具", 1, "Power", "在你的回合开始时，抽1张牌，丢弃1张牌。", 0],
    Tracking: ["跟踪", 2, "Power", "处于虚弱状态的敌人受到的攻击伤害增加50%。", 0],
    Untouchable: ["触不可及", 2, "Skill", "奇巧。 获得6点格挡。", 0],
    UpMySleeve: ["袖里乾坤", 2, "Skill", "将3张小刀加入你的手牌。 这张牌的耗能减少1。", 0],
    WellLaidPlans: ["计划妥当", 2, "Power", "在你的回合结束时，你不再丢弃你的手牌。", 0],
    WraithForm: ["幽魂形态", 3, "Power", "获得2无实体。 在你的回合开始时，失去1点敏捷。", 0],
    Alignment: ["星位序列", 0, "Skill", "获得2点能量。", 2],
    Arsenal: ["武器库", 1, "Power", "每当你生成一张牌，就获得1点力量。", 0],
    AstralPulse: ["星界脉冲", 0, "Attack", "对所有敌人造成6点伤害两次。", 3],
    BeatIntoShape: ["锻打成型", 1, "Attack", "造成5点伤害。 铸造5。 本回合内，你此前每击中过该敌人一次，这张牌就额外铸造5点。", 0],
    Begone: ["下去！", 1, "Skill", "选择你手牌中的一张牌，将其变化为仆从打击。", 0],
    BigBang: ["大爆炸", 0, "Skill", "抽1张牌。 获得1点能量。 获得1点星星。 铸造5。 消耗。", 0],
    BlackHole: ["黑洞", 1, "Power", "每当你花费或获得1点星星时，对所有敌人造成3点伤害。", 0],
    Bombardment: ["轰击", 3, "Attack", "造成18点伤害。 你的回合开始时，如果这张牌在你的消耗牌堆中，则将其打出。 消耗。", 0],
    Bulwark: ["铸墙", 2, "Skill", "获得12点格挡。 铸造10。", 0],
    BundleOfJoy: ["新生之喜", 1, "Skill", "将3张随机无色牌添加到你的手牌。 消耗。", 0],
    CelestialMight: ["天穹之力", 2, "Attack", "造成6点伤害3次。", 0],
    Charge: ["冲锋！！", 1, "Skill", "选择你抽牌堆中的2张牌，将其变化为 仆从俯冲。", 0],
    ChildOfTheStars: ["群星之子", 1, "Power", "每当你花费1点星星时，每花费一点1点星星，获得2点格挡。", 0],
    CloakOfStars: ["群星斗篷", 0, "Skill", "获得7点格挡。", 1],
    CollisionCourse: ["碰撞轨迹", 0, "Attack", "造成10点伤害。 将一张碎屑添加至你的手牌。", 0],
    Comet: ["彗星", 0, "Attack", "造成33点伤害。 给予3层虚弱。 给予3层易伤。", 5],
    Conqueror: ["征服者", 1, "Skill", "铸造3。 君王之剑在本回合对敌人造成双倍伤害。", 0],
    Convergence: ["汇流", 1, "Skill", "在本回合保留你的手牌。 在下个回合， 获得1点能量与1点星星。", 0],
    CosmicIndifference: ["宇宙冷漠", 1, "Skill", "获得6点格挡。 将弃牌堆中的一张牌放到你的抽牌堆的顶部。", 0],
    CrashLanding: ["迫降", 1, "Attack", "对所有敌人造成21点伤害。 用碎屑填满你的手牌。", 0],
    CrescentSpear: ["新月长矛", 1, "Attack", "造成8点伤害。 你每有一张拥有1点星星耗能的卡牌，这张牌就额外造成2点伤害。", 1],
    CrushUnder: ["下砸", 1, "Attack", "对所有敌人造成8点伤害。所有敌人在本回合失去1点力量。", 0],
    DecisionsDecisions: ["抉择，抉择", 0, "Skill", "抽3张牌。 选择你手牌中的一张技能牌，并将其打出3次。 消耗。", 6],
    DefendRegent: ["防御", 1, "Skill", "获得5点格挡。", 0],
    Devastate: ["葬送", 1, "Attack", "造成35点伤害。", 4],
    DyingStar: ["星灭", 1, "Attack", "虚无。 对所有敌人造成9点伤害。所有敌人在本回合中失去9点力量。", 3],
    FallingStar: ["陨星", 0, "Attack", "造成8点伤害。 给予1层虚弱。 给予1层易伤。", 2],
    ForegoneConclusion: ["既定事项", 1, "Skill", "在下个回合，从你的抽牌堆中选择2张牌放入你的手牌。", 0],
    Furnace: ["熔炉", 1, "Power", "在你的回合开始时，铸造5。", 0],
    GammaBlast: ["伽马爆破", 0, "Attack", "造成13点伤害。 给予2层虚弱。 给予2层易伤。", 3],
    GatherLight: ["收集光辉", 1, "Skill", "获得8点格挡。 获得1点星星。", 0],
    Genesis: ["创世纪", 2, "Power", "在你的回合开始时，获得2点星星。", 0],
    Glimmer: ["微光", 1, "Skill", "抽3张牌。 将你手牌中的1张牌放到抽牌堆顶部。", 0],
    Glitterstream: ["流光溢彩", 2, "Skill", "获得11点格挡。 在下一回合获得5点格挡。", 0],
    Glow: ["辉光", 1, "Skill", "获得1点星星。 抽1张牌。 下一回合抽1张牌。", 0],
    Guards: ["护驾！！！", 2, "Skill", "将你手牌中的任意张牌变化为仆从捐躯。 消耗。", 0],
    GuidingStar: ["引导之星", 1, "Attack", "造成12点伤害。 在下个回合抽2张牌。", 1],
    HeavenlyDrill: ["天际钻头", -1, "Attack", "造成8点伤害X次。 如果X的最终数值为4或以上，则将X的数值翻倍。", 0],
    Hegemony: ["霸权", 2, "Attack", "造成15点伤害。 在下个回合获得2点能量。", 0],
    HeirloomHammer: ["传承之锤", 2, "Attack", "造成20点伤害。 选择你手牌中的一张无色牌。将这张牌的一张复制品放入你的手牌。", 0],
    HiddenCache: ["隐秘藏品", 1, "Skill", "获得1点星星。 在下个回合获得3点星星。", 0],
    IAmInvincible: ["所向无敌", 1, "Skill", "获得10点格挡。 在你的回合结束时，如果这张牌位于抽牌堆顶部，则将其打出。", 0],
    KinglyKick: ["王者之踢", 4, "Attack", "造成27点伤害。 每当你抽到这张牌时，这张牌的耗能减少1。", 0],
    KinglyPunch: ["王者之拳", 1, "Attack", "造成8点伤害。 每当你抽到这张牌时，在这场战斗中其伤害增加4。", 0],
    KnockoutBlow: ["决胜一击", 3, "Attack", "造成30点伤害。 如果此牌击杀了敌人，获得5点星星。", 0],
    KnowThyPlace: ["何人僭越", 0, "Skill", "给予1层虚弱。 给予1层易伤。 消耗。", 0],
    LunarBlast: ["月面射击", 0, "Attack", "本回合中每打出过一张技能牌，此牌额外造成4点伤害一次。", 0],
    MakeItSo: ["如此甚好", 0, "Attack", "造成6点伤害。 你每在一回合内打出3张技能牌，就将这张牌放入你的手牌。", 0],
    ManifestAuthority: ["君权自授", 1, "Skill", "获得7点格挡。 将一张随机无色牌加入你的手牌。", 0],
    MeteorShower: ["流星雨", 0, "Attack", "对所有敌人造成14点伤害。 给予所有敌人2层虚弱和易伤。", 2],
    MonarchsGaze: ["王之凝视", 2, "Power", "每当你攻击敌人的时候，这名敌人在本回合失去1点力量。", 0],
    Monologue: ["独白", 0, "Skill", "每当你在本回合打出卡牌时，在本回合获得1点力量。", 0],
    NeutronAegis: ["中子护盾", 1, "Power", "获得8层覆甲。", 5],
    Orbit: ["环绕轨道", 2, "Power", "你每花费41点能量， 就获得1点能量。", 0],
    PaleBlueDot: ["暗淡蓝点", 1, "Power", "如果你在一回合内打出了大于等于5张牌，在下个回合开始时抽1张牌。", 0],
    Parry: ["招架", 1, "Power", "君王之剑现在能让你获得10点格挡。", 0],
    ParticleWall: ["粒子墙", 0, "Skill", "获得9点格挡。 将此牌返回你的手牌。", 2],
    Patter: ["星星点点", 1, "Skill", "获得8点格挡。 获得2点活力。", 0],
    PhotonCut: ["光子切割", 1, "Attack", "造成10点伤害。 抽1张牌。 将手牌中的一张牌放到抽牌堆顶部。", 0],
    PillarOfCreation: ["创世之柱", 1, "Power", "你每次生成卡牌时，获得2点格挡。", 0],
    Prophesize: ["预言", 2, "Skill", "抽6张牌。", 0],
    Quasar: ["类星体", 0, "Skill", "从3张随机无色牌中选择1张加入你的手牌。", 2],
    Radiate: ["辐射", 0, "Attack", "你在本回合每获得一点1点星星，此牌就对所有敌人造成3点伤害一次。", 0],
    RefineBlade: ["淬炼刀刃", 1, "Skill", "铸造8。 在下个回合获得1点能量。", 0],
    Reflect: ["倒映", 1, "Skill", "获得15点格挡。 在本回合将你格挡掉的攻击伤害反弹给攻击者。", 3],
    Resonance: ["共鸣", 1, "Skill", "获得1点力量。所有敌人失去1点力量。", 2],
    RoyalGamble: ["胜券在王", 0, "Skill", "获得91点星星。 消耗。", 5],
    Royalties: ["王国资产", 1, "Power", "在战斗结束时，获得30金币。", 0],
    SeekingEdge: ["追踪之刃", 1, "Power", "铸造7。 君王之剑现在会对所有敌人造成伤害。", 0],
    SevenStars: ["七星", 2, "Attack", "对所有敌人造成7点伤害7次。", 7],
    ShiningStrike: ["明耀打击", 1, "Attack", "造成8点伤害。 获得2点星星。 将这张牌放置于你的抽牌堆顶部。", 0],
    SolarStrike: ["太阳打击", 1, "Attack", "造成9点伤害。 获得1点星星。", 0],
    SpectrumShift: ["光谱偏移", 2, "Power", "在你的回合开始时，将1张随机无色牌添加到你的手牌中。", 0],
    SpoilsOfBattle: ["战利品", 1, "Skill", "铸造6。 抽2张牌。", 0],
    Stardust: ["星尘", 0, "Attack", "随机对敌人造成5点伤害X次。", -1],
    StrikeRegent: ["打击", 1, "Attack", "造成6点伤害。", 0],
    SummonForth: ["征召上前", 1, "Skill", "不论何处，将君王之剑放入你的手牌。 铸造8。", 0],
    Supermassive: ["超质量体", 1, "Attack", "造成5点伤害。 你在本场战斗中每生成过一张牌，这张牌就额外造成3点伤害。", 0],
    SwordSage: ["剑圣", 2, "Power", "君王之剑获得重放1。", 0],
    Terraforming: ["地形改造", 1, "Skill", "获得7点活力。", 0],
    TheSealedThrone: ["封印王座", 1, "Power", "你每打出一张牌，获得1点星星。", 3],
    TheSmith: ["铸剑者", 1, "Skill", "铸造30。", 4],
    Tyranny: ["暴政", 1, "Power", "在你的回合开始时，抽一张牌，并从你的手牌中消耗1张牌。", 0],
    Venerate: ["崇拜", 1, "Skill", "获得2点星星。", 0],
    VoidForm: ["虚空形态", 3, "Power", "虚无。 结束你的回合。 你可以免费打出每回合的前2张牌。", 0],
    WroughtInWar: ["战火铸就", 1, "Attack", "造成7点伤害。 铸造7。", 0],
    Afterlife: ["来生", 1, "Skill", "召唤6。 消耗。", 0],
    BansheesCry: ["女妖之嚎", 9, "Attack", "对所有敌人造成33点伤害。 本场战斗中每打出过一张虚无牌，此牌的耗能就减少2点能量。", 0],
    BlightStrike: ["荒疫打击", 1, "Attack", "造成8点伤害。 给予等量于所造成伤害的灾厄。", 0],
    Bodyguard: ["护卫", 1, "Skill", "召唤5。", 0],
    BoneShards: ["碎骨", 1, "Attack", "如果奥斯提存活，则他对所有敌人造成9点伤害并且你获得9点格挡。 然后奥斯提死去。", 0],
    BorrowedTime: ["预借时间", 1, "Skill", "获得41点能量。 所有卡牌在本回合耗能增加1点能量。", 0],
    Bury: ["埋葬", 4, "Attack", "造成52点伤害。", 0],
    Calcify: ["钙化", 1, "Power", "奥斯提的攻击额外造成4点伤害。", 0],
    CallOfTheVoid: ["虚空之唤", 1, "Power", "在你的回合开始时，将1张随机牌添加到你的手牌中。添加的牌会获得虚无。", 0],
    CaptureSpirit: ["捕捉灵魂", 1, "Skill", "敌人失去3点生命。 将3张灵魂加入你的抽牌堆。", 0],
    Cleanse: ["洁净", 1, "Skill", "召唤3。 从你的抽牌堆中选择一张牌将其消耗。", 0],
    Countdown: ["倒数计时", 1, "Power", "在你的回合开始时，给予随机敌人6层灾厄。", 0],
    DanseMacabre: ["死亡之舞", 1, "Power", "每当你打出一张耗能大于等于2点能量的牌时，获得4点格挡。", 0],
    DeathMarch: ["死亡行军", 1, "Attack", "造成8点伤害。 你在回合进行中每抽到一张牌，都会使其额外造成4点伤害。", 0],
    Deathbringer: ["死亡使者", 2, "Skill", "给予所有敌人21层灾厄和1层虚弱。", 0],
    DeathsDoor: ["死亡之门", 1, "Skill", "获得6点格挡。 如果你在本回合中曾给予过灾厄，则额外获得2次格挡。", 0],
    Debilitate: ["摧残", 1, "Attack", "造成10点伤害。 在接下来的2回合内，该敌人身上的易伤与虚弱效果翻倍。", 0],
    DefendNecrobinder: ["防御", 1, "Skill", "获得5点格挡。", 0],
    Defile: ["玷污", 1, "Attack", "虚无。 造成13点伤害。", 0],
    Defy: ["违逆", 1, "Skill", "虚无。 获得6点格挡。 给予1层虚弱。", 0],
    Delay: ["拖延", 2, "Skill", "获得11点格挡。 在下个回合， 获得1点能量。", 0],
    Demesne: ["领域", 3, "Power", "虚无。 在你的回合开始时，获得1点能量并额外多抽1张牌。", 0],
    DevourLife: ["吞噬生命", 1, "Power", "每当你打出一张灵魂时，召唤1。", 0],
    Dirge: ["挽歌", -1, "Skill", "召唤3X次。 将X张灵魂添加到你的抽牌堆中。 消耗。", 0],
    DrainPower: ["能量汲取", 1, "Attack", "造成10点伤害。 随机升级你弃牌堆中的2张牌。", 0],
    Dredge: ["清淤", 1, "Skill", "将3张牌从弃牌堆加入你的手牌。 消耗。", 0],
    Eidolon: ["幻景", 2, "Skill", "打出你消耗牌堆中的所有虚无牌。 消耗。", 0],
    EndOfDays: ["末日降临", 3, "Skill", "给予所有敌人29层灾厄。 杀死所有灾厄大于等于当前生命值的敌人。", 0],
    EnfeeblingTouch: ["弱化之触", 1, "Skill", "虚无。 让一名敌人在本回合内失去8点力量。", 0],
    Eradicate: ["根除", -1, "Attack", "保留。 造成11点伤害X次。", 0],
    Fear: ["恐惧", 1, "Attack", "虚无。 造成7点伤害。 给予1层易伤。", 0],
    Fetch: ["取回", 0, "Attack", "奥斯提造成3点伤害。 如果这是这张牌第一次在本回合被打出，则抽1张牌。", 0],
    Flatten: ["重压", 2, "Attack", "奥斯提造成12点伤害。 如果奥斯提本回合攻击过，则这张牌的耗能变为01点能量。", 0],
    ForbiddenGrimoire: ["禁忌魔典", 2, "Power", "在战斗结束时，你可以从你的牌组中选一张牌移除。 永恒。", 0],
    Friendship: ["友谊", 1, "Power", "失去2点力量。 在每个回合开始时获得1点能量。", 0],
    GraveWarden: ["守墓人", 1, "Skill", "获得8点格挡。 将一张灵魂放入你的抽牌堆中。", 0],
    Graveblast: ["坟冢爆射", 1, "Attack", "造成4点伤害。 将弃牌堆中的一张牌放入你的手牌。 消耗。", 0],
    Hang: ["吊杀", 1, "Attack", "造成10点伤害。 让所有“吊杀”牌对这名敌人造成的伤害翻倍。", 0],
    Haunt: ["纠缠", 1, "Power", "每当你打出一张灵魂时，随机一名敌人失去7点生命。", 0],
    HighFive: ["击掌", 2, "Attack", "奥斯提对所有敌人 造成11点伤害并给予它们 2层易伤。", 0],
    Invoke: ["唤起", 1, "Skill", "在下个回合召唤2并获得2点能量。", 0],
    Lethality: ["致死性", 1, "Power", "虚无。 每回合的第一张攻击牌会造成50%额外伤害。", 0],
    Melancholy: ["忧郁", 3, "Skill", "获得13点格挡。 每当有任何生物死亡时，这张牌的耗能减少1点能量。", 0],
    Misery: ["苦难", 0, "Attack", "造成7点伤害。 给予其他敌人该名敌人身上的所有负面效果。", 0],
    NecroMastery: ["亡灵精通", 2, "Power", "召唤5。 每当奥斯提失去生命值时， 所有敌人失去等量生命值。", 0],
    NegativePulse: ["负能量脉冲", 1, "Skill", "获得5点格挡。 给予所有敌人7层灾厄。", 0],
    Neurosurge: ["精神过载", 0, "Power", "获得3点能量。 抽2张牌。 在你的回合开始时，给予自身3层灾厄。", 0],
    NoEscape: ["无处可逃", 1, "Skill", "给予10层灾厄，敌人身上每有10层灾厄，则额外给予这名敌人5层灾厄。", 0],
    Oblivion: ["湮灭", 0, "Skill", "打出此牌后，你在本回合内每打出一张牌，就给予该敌人3层灾厄。", 0],
    Pagestorm: ["书页风暴", 1, "Power", "每当你抽到一张虚无牌时, 抽1张牌。", 0],
    Parse: ["领会", 1, "Skill", "虚无。 抽3张牌。", 0],
    Poke: ["戳击", 0, "Attack", "奥斯提造成6点伤害。", 0],
    Protector: ["守护者", 1, "Attack", "奥斯提造成10点伤害。 额外造成等量于奥斯提最大生命值的伤害。", 0],
    PullAggro: ["吸引仇恨", 2, "Skill", "召唤4。 获得7点格挡。", 0],
    PullFromBelow: ["亡魂牵引", 1, "Attack", "本场战斗中每打出过一张虚无牌，此牌就造成5点伤害一次。", 0],
    Putrefy: ["腐败", 1, "Skill", "给予2层虚弱。 给予2层易伤。 消耗。", 0],
    Rattle: ["猛晃", 1, "Attack", "奥斯提造成7点伤害。 本回合每使用过一次奥斯提攻击牌，此牌就额外造成一次伤害。", 0],
    Reanimate: ["死者苏生", 3, "Skill", "召唤20。 消耗。", 0],
    Reap: ["收割", 3, "Attack", "保留。 造成27点伤害。", 0],
    ReaperForm: ["死神形态", 3, "Power", "每当你的攻击造成伤害时，同时给予等量的灾厄。", 0],
    Reave: ["剥夺", 1, "Attack", "造成10点伤害。 将一张灵魂加入你的抽牌堆。", 0],
    RightHandHand: ["得力助手", 0, "Attack", "奥斯提造成4点伤害。 每当你打出耗能为2点能量或以上的牌，将此牌从弃牌堆放回你的手牌。", 0],
    Sacrifice: ["牺牲", 1, "Skill", "保留。 如果奥斯提存活，则他死去，然后你获得等量于其最大生命值三倍的格挡。", 0],
    Scourge: ["鞭打", 1, "Skill", "给予13层灾厄。 抽1张牌。", 0],
    SculptingStrike: ["雕琢打击", 1, "Attack", "造成9点伤害。 为一张手牌添加虚无。", 0],
    Seance: ["降灵", 1, "Skill", "虚无。 将你抽牌堆中的一张牌变化为灵魂。", 0],
    SentryMode: ["哨卫模式", 2, "Power", "在你的回合开始时，将1张扫荡凝视加入你的手牌。", 0],
    Severance: ["切断", 2, "Attack", "造成13点伤害。 将一张灵魂分别加入你的抽牌堆，手牌和弃牌堆中。", 0],
    SharedFate: ["命运同担", 0, "Skill", "失去2点力量。 敌人失去2点力量。 消耗。", 0],
    Shroud: ["厄运之衣", 1, "Power", "每当你给予灾厄时，获得3点格挡。", 0],
    SicEm: ["紧追不放", 1, "Attack", "奥斯提造成5点伤害。 在本回合内，每当奥斯提攻击这名敌人时，召唤3。", 0],
    SleightOfFlesh: ["血肉戏法", 2, "Power", "每当你给予一个敌人负面状态时，使其受到9点伤害。", 0],
    Snap: ["响指", 1, "Attack", "奥斯提造成7点伤害。 给手牌中的一张牌添加保留。", 0],
    SoulStorm: ["灵魂风暴", 1, "Attack", "造成9点伤害。 你的消耗牌堆中每有一张灵魂，伤害增加4。", 0],
    Sow: ["播种", 1, "Attack", "保留。 对所有敌人造成8点伤害。", 0],
    SpiritOfAsh: ["灰烬之灵", 1, "Power", "每当你打出一张虚无牌时，获得4点格挡。", 0],
    Spur: ["增生", 1, "Skill", "保留。 召唤3。 奥斯提回复5点生命。", 0],
    Squeeze: ["榨取", 3, "Attack", "奥斯提造成25点伤害。 你每有一张奥斯提的攻击牌，这张牌就额外造成5点伤害。", 0],
    StrikeNecrobinder: ["打击", 1, "Attack", "造成6点伤害。", 0],
    TheScythe: ["巨镰", 2, "Attack", "造成13点伤害。 这张牌在本局游戏中的伤害永久性增加5。 消耗。", 0],
    TimesUp: ["大限已至", 2, "Attack", "造成等量于该敌人身上的灾厄层数的伤害。", 0],
    Transfigure: ["重构", 1, "Skill", "给一张手牌添加重放。 其耗能增加11点能量。 消耗。", 0],
    Undeath: ["不死", 0, "Skill", "获得7点格挡。 在弃牌堆放入一张此牌的复制品。", 0],
    Unleash: ["出击", 1, "Attack", "奥斯提造成6点伤害。 这张牌额外造成等量于奥斯提当前生命值的伤害。", 0],
    Veilpiercer: ["刺破帷幕", 1, "Attack", "造成10点伤害。 你打出的下一张虚无牌耗能变为01点能量。", 0],
    Wisp: ["鬼火", 0, "Skill", "获得1点能量。 消耗。", 0],
    AdaptiveStrike: ["适应打击", 2, "Attack", "造成18点伤害。 将这张牌的一张01点能量复制品添加到你的弃牌堆。", 0],
    AllForOne: ["万物一心", 2, "Attack", "造成10点伤害。 将你弃牌堆中的所有01点能量牌放入你的手牌。", 0],
    BallLightning: ["球状闪电", 1, "Attack", "造成7点伤害。 生成1个闪电充能球。", 0],
    Barrage: ["弹幕齐射", 1, "Attack", "当前每有一个充能球，造成5点伤害。", 0],
    BeamCell: ["光束射线", 0, "Attack", "造成3点伤害。 给予1层易伤。", 0],
    BiasedCognition: ["偏差认知", 1, "Power", "获得5点集中。 在你的回合开始时，失去1点集中。", 0],
    BoostAway: ["高速脱离", 0, "Skill", "获得6点格挡。 将一张晕眩添加到你的弃牌堆中。", 0],
    BootSequence: ["启动流程", 0, "Skill", "固有。 获得10点格挡。 消耗。", 0],
    Buffer: ["缓冲", 2, "Power", "阻止下1次你受到的生命值损伤。", 0],
    BulkUp: ["暴涨", 2, "Power", "失去1个充能球栏位。 获得2点力量。 获得2点敏捷。", 0],
    Capacitor: ["扩容", 1, "Power", "获得2个充能球栏位。", 0],
    Chaos: ["混沌", 1, "Skill", "生成1个随机充能球。", 0],
    ChargeBattery: ["充电", 1, "Skill", "获得7点格挡。 在下个回合获得1点能量。", 0],
    Chill: ["冰寒", 0, "Skill", "当前每有一名敌人，就生成1个冰霜充能球。 消耗。", 0],
    Claw: ["爪击", 0, "Attack", "造成3点伤害。 本场战斗中所有爪击卡牌的伤害增加2点。", 0],
    ColdSnap: ["寒流", 1, "Attack", "造成6点伤害。 生成1个冰霜充能球。", 0],
    Compact: ["压缩", 1, "Skill", "获得6点格挡。 将你手牌中的全部状态牌变化为燃料。", 0],
    CompileDriver: ["编译冲击", 1, "Attack", "造成7点伤害。 你每有一种不同的充能球，就抽一张牌。 （抽0张牌）", 0],
    ConsumingShadow: ["吞噬暗影", 2, "Power", "生成2个黑暗充能球。 在你的回合结束时，激发你最左侧的充能球。", 0],
    Coolant: ["冷却剂", 1, "Power", "在你的回合开始时，你每有一种不同的充能球，就获得2点格挡。", 0],
    Coolheaded: ["冷静头脑", 1, "Skill", "生成1个冰霜充能球。 抽1张牌。", 0],
    CreativeAi: ["创造性AI", 3, "Power", "在你的回合开始时，将一张随机能力牌加入你的手牌。", 0],
    Darkness: ["漆黑", 1, "Skill", "生成1个黑暗充能球。 触发所有黑暗充能球的被动。", 0],
    DefendDefect: ["防御", 1, "Skill", "获得5点格挡。", 0],
    Defragment: ["碎片整理", 1, "Power", "获得1点集中。", 0],
    DoubleEnergy: ["双倍能量", 1, "Skill", "将你的能量翻倍。 消耗。", 0],
    Dualcast: ["双重释放", 1, "Skill", "激发你最右侧的充能球两次。", 0],
    EchoForm: ["回响形态", 3, "Power", "虚无。 你每回合打出的第一张牌会被打出两次。", 0],
    Feral: ["野性", 2, "Power", "你每回合打出的第一张 耗能为01点能量的攻击牌， 会放回你的手牌。", 0],
    FightThrough: ["强撑", 1, "Skill", "获得13点格挡。 将2张伤口加入你的弃牌堆。", 0],
    FlakCannon: ["散射炮", 2, "Attack", "消耗你所有的状态牌。 每有一张被消耗的牌，就随机对敌人造成8点伤害。", 0],
    FocusedStrike: ["集中打击", 1, "Attack", "造成9点伤害。 在本回合获得1点集中。", 0],
    Ftl: ["超越光速", 0, "Attack", "造成5点伤害。 如果你在这回合打出的牌数小于3张，抽1张牌。", 0],
    Fusion: ["聚变", 1, "Skill", "生成1个等离子充能球。 消耗。", 0],
    GeneticAlgorithm: ["遗传算法", 1, "Skill", "获得1点格挡。 每打出一次，这张牌在本局游戏中的格挡值永久增加3点。 消耗。", 0],
    Glacier: ["冰川", 2, "Skill", "获得6点格挡。 生成2个冰霜充能球。", 0],
    Glasswork: ["玻璃工艺", 1, "Skill", "获得5点格挡。 生成1个玻璃充能球。", 0],
    GoForTheEyes: ["眼部攻击", 0, "Attack", "造成3点伤害。 如果敌人的意图是攻击，则给予1层虚弱。", 0],
    GunkUp: ["污秽攻击", 1, "Attack", "造成4点伤害3次。 在你的弃牌堆中加入一张黏液。", 0],
    Hailstorm: ["冰雹风暴", 1, "Power", "在你的回合结束时，如果你有冰霜充能球，则对所有敌人造成6点伤害。", 0],
    HelixDrill: ["螺旋钻击", 0, "Attack", "在本回合中，这张牌以外使用的每个1点能量，都会使此牌造成3点伤害一次。", 0],
    Hologram: ["全息影像", 1, "Skill", "获得3点格挡。 将弃牌堆中的一张牌放入你的手牌。 消耗。", 0],
    Hotfix: ["热修复", 0, "Skill", "在本回合获得2点集中。 消耗。", 0],
    Hyperbeam: ["超能光束", 2, "Attack", "对所有敌人造成24点伤害。 在本回合失去3点集中。", 0],
    IceLance: ["冰之长枪", 3, "Attack", "造成19点伤害。 生成3个冰霜充能球。", 0],
    Iteration: ["迭代", 1, "Power", "每回合你第一次抽到状态牌时，抽2张牌。", 0],
    Leap: ["飞跃", 1, "Skill", "获得9点格挡。", 0],
    LightningRod: ["引雷针", 1, "Skill", "获得4点格挡。 在下2个回合开始时,生成1个闪电充能球。", 0],
    Loop: ["循环", 1, "Power", "在你的回合开始时，触发你最右侧的一个充能球的被动能力。", 0],
    MachineLearning: ["机器学习", 1, "Power", "在你的回合开始时，额外抽1张牌。", 0],
    MeteorStrike: ["陨石打击", 5, "Attack", "造成24点伤害。 生成3个等离子充能球。", 0],
    Modded: ["模组改造", 0, "Skill", "获得1个充能球栏位。 抽1张牌。这张牌的耗能加1。", 0],
    MomentumStrike: ["趁势打击", 1, "Attack", "造成11点伤害。 这张牌的耗能降为01点能量。", 0],
    MultiCast: ["多重释放", -1, "Skill", "激发你最右侧的充能球X次。", 0],
    Null: ["空值", 2, "Attack", "造成10点伤害。 给予1层虚弱。 生成1个黑暗充能球。", 0],
    Overclock: ["超频", 0, "Skill", "抽2张牌。 将一张灼伤加入你的弃牌堆。", 0],
    Quadcast: ["四重释放", 1, "Skill", "激发你最右侧的充能球4次。", 0],
    Rainbow: ["彩虹", 2, "Skill", "生成1个闪电充能球。 生成1个冰霜充能球。 生成1个黑暗充能球。 消耗。", 0],
    Reboot: ["重启", 0, "Skill", "将你的所有未消耗的卡牌重新洗牌放入抽牌堆。 抽4张牌。 消耗。", 0],
    Refract: ["折射", 3, "Attack", "造成10点伤害两次。 生成2个玻璃充能球。", 0],
    RocketPunch: ["火箭飞拳", 2, "Attack", "造成13点伤害。 抽1张牌。 每当你生成状态牌时，此牌的耗能将在下一次打出前减少11点能量。", 0],
    Scavenge: ["内存清理", 1, "Skill", "消耗一张牌。 在下个回合获得2点能量。", 0],
    Scrape: ["刮削", 1, "Attack", "造成7点伤害。 抽4张牌。 丢弃抽到的牌中耗能不为01点能量的牌。", 0],
    ShadowShield: ["暗影之盾", 2, "Skill", "获得11点格挡。 生成1个黑暗充能球。", 0],
    Shatter: ["打碎", 1, "Attack", "对所有敌人造成7点伤害。 激发你的所有充能球两次。 消耗。", 0],
    SignalBoost: ["信号增强", 1, "Skill", "你的下一张能力牌会额外打出一次。 消耗。", 0],
    Skim: ["快速检索", 1, "Skill", "抽3张牌。", 0],
    Smokestack: ["烟囱", 1, "Power", "每当你生成一张状态牌时，对所有敌人造成5点伤害。", 0],
    Spinner: ["旋转工艺", 1, "Power", "在你的回合开始时，生成1个玻璃充能球。", 0],
    Storm: ["雷暴", 1, "Power", "每当你打出一张能力牌时，生成1个闪电充能球。", 0],
    StrikeDefect: ["打击", 1, "Attack", "造成6点伤害。", 0],
    Subroutine: ["子程序", 1, "Power", "当你打出一张能力牌时，获得1点能量。", 0],
    Sunder: ["分离", 3, "Attack", "造成26点伤害。 如果这张牌击杀了敌人，则获得3点能量。", 0],
    Supercritical: ["超临界态", 0, "Skill", "获得41点能量。 消耗。", 0],
    SweepingBeam: ["扫荡射线", 1, "Attack", "对所有敌人造成6点伤害。 抽1张牌。", 0],
    Synchronize: ["同步", 1, "Skill", "你每有一种不同的充能球，就在本回合获得1点集中。", 0],
    Synthesis: ["人工合成", 2, "Attack", "造成14点伤害。 你打出的下一张能力牌耗能变为01点能量。", 0],
    Tempest: ["暴风雨", -1, "Skill", "生成X个闪电充能球。", 0],
    TeslaCoil: ["特斯拉线圈", 0, "Attack", "造成3点伤害。 对该敌人触发你的所有闪电充能球的被动。", 0],
    Thunder: ["雷霆", 1, "Power", "每当你激发闪电充能球时，对被命中的敌人造成8点伤害。", 0],
    TrashToTreasure: ["化废为宝", 1, "Power", "每当你生成状态牌的时候，随机生成一个充能球。", 0],
    Turbo: ["内核加速", 0, "Skill", "获得2点能量。 将一张虚空加入你的弃牌堆。", 0],
    Uproar: ["骚动", 2, "Attack", "造成6点伤害两次。 随机打出你的抽牌堆中的1张攻击牌。", 0],
    Voltaic: ["电流相生", 3, "Skill", "生成等量于你在这场战斗中生成过的闪电充能球数量的闪电充能球。 消耗。", 0],
    WhiteNoise: ["白噪声", 1, "Skill", "将一张随机能力牌加入你的手牌。这张牌在本回合内免费打出。 消耗。", 0],
    Zap: ["电击", 1, "Skill", "生成1个闪电充能球。", 0],
    Alchemize: ["炼制药水", 1, "Skill", "获得一瓶随机药水。 消耗。", 0],
    Anointed: ["天选", 1, "Skill", "将你抽牌堆中的所有稀有牌放入你的手牌。 消耗。", 0],
    Automation: ["自动化", 1, "Power", "你每抽10张牌，获得1点能量。", 0],
    BeatDown: ["狠揍", 3, "Skill", "打出你弃牌堆中的3张随机攻击牌。", 0],
    Bolas: ["流星锤", 0, "Attack", "造成3点伤害。 在你的下个回合开始时，将此卡返回你的手牌。", 0],
    Calamity: ["劫难", 3, "Power", "每当你打出一张攻击牌时，将一张随机攻击牌添加到你的手牌。", 0],
    Catastrophe: ["横祸", 2, "Skill", "从你的抽牌堆中随机打出2张牌。", 0],
    DarkShackles: ["黑暗镣铐", 0, "Skill", "使一名敌人在本回合失去9点力量。 消耗。", 0],
    Discovery: ["发现", 1, "Skill", "从3张随机牌中选择1张加入你的手牌。这张牌在本回合可以免费打出。 消耗。", 0],
    DramaticEntrance: ["闪亮登场", 0, "Attack", "固有。 对所有敌人造成11点伤害。 消耗。", 0],
    Entropy: ["熵", 1, "Power", "在你的回合开始时，变化你手牌中的1张牌。", 0],
    Equilibrium: ["均衡", 2, "Skill", "获得13点格挡。 在本回合保留你的手牌。", 0],
    EternalArmor: ["永恒铠甲", 3, "Power", "获得9层覆甲。", 0],
    Fasten: ["勒紧", 1, "Power", "从“防御”牌中额外获得4点格挡。", 0],
    Finesse: ["妙计", 0, "Skill", "获得4点格挡。 抽1张牌。", 0],
    Fisticuffs: ["拳斗", 1, "Attack", "造成7点伤害。 获得等量于所造成伤害的格挡。", 0],
    FlashOfSteel: ["亮剑", 0, "Attack", "造成5点伤害。 抽1张牌。", 0],
    GoldAxe: ["金斧", 1, "Attack", "造成本场战斗中所打出牌数的伤害。", 0],
    HandOfGreed: ["贪婪之手", 2, "Attack", "造成20点伤害。 斩杀时，获得20金币。", 0],
    HiddenGem: ["未掘宝石", 1, "Skill", "你抽牌堆中的一张没有重放的随机牌获得2层重放。", 0],
    Impatience: ["急躁", 0, "Skill", "如果你的手牌中没有攻击牌，抽2张牌。", 0],
    JackOfAllTrades: ["花样百出", 0, "Skill", "将1张随机无色牌加入你的手牌。 消耗。", 0],
    Jackpot: ["大奖", 3, "Attack", "造成25点伤害。 将3张随机01点能量的牌加入你的手牌。", 0],
    MasterOfStrategy: ["战略大师", 0, "Skill", "抽3张牌。 消耗。", 0],
    Mayhem: ["乱战", 2, "Power", "在你的回合开始时，打出你抽牌堆顶部的牌。", 0],
    MindBlast: ["心灵震慑", 1, "Attack", "固有。 造成你抽牌堆中剩余牌数的伤害。", 0],
    Nostalgia: ["怀旧", 1, "Power", "每回合首次打出攻击或技能牌时，将其置于你的抽牌堆顶端。", 0],
    Omnislice: ["万向斩", 0, "Attack", "造成8点伤害。 对所有其他敌人造成等量的伤害。", 0],
    Panache: ["神气制胜", 0, "Power", "每当你在一回合内打出五张牌时，对所有敌人造成10点伤害。", 0],
    PanicButton: ["应急按钮", 0, "Skill", "获得30点格挡。 你在接下来的2回合内无法再从卡牌中获得格挡。 消耗。", 0],
    PrepTime: ["准备时间", 1, "Power", "在你的回合开始时，获得4点活力。", 0],
    Production: ["生产制造", 0, "Skill", "获得2点能量。 消耗。", 0],
    Prolong: ["延伸", 0, "Skill", "在下个回合获得等量于你当前格挡值的格挡。 消耗。", 0],
    Prowess: ["非凡技艺", 1, "Power", "获得1点力量。 获得1点敏捷。", 0],
    Purity: ["净化", 0, "Skill", "保留。 从手牌中选择最多3张牌消耗。 消耗。", 0],
    Rend: ["撕碎", 1, "Attack", "造成10点伤害。 该名敌人身上每有一种负面效果，就额外造成5点伤害。", 0],
    Restlessness: ["心神不宁", 0, "Skill", "保留。 如果你的手牌为空，则抽2张牌并获得2点能量。", 0],
    RollingBoulder: ["滚石", 3, "Power", "在你的回合开始时，对所有敌人造成5点伤害，然后将该伤害增加5点。", 0],
    Salvo: ["箭雨", 1, "Attack", "造成12点伤害。 在本回合保留你的手牌。", 0],
    Scrawl: ["潦草急就", 1, "Skill", "抽牌直到抽满手牌。 消耗。", 0],
    SecretTechnique: ["秘密技法", 0, "Skill", "从抽牌堆中选择一张技能牌放入你的手牌。 消耗。", 0],
    SecretWeapon: ["秘密武器", 0, "Skill", "从抽牌堆中选择一张攻击牌放入你的手牌。 消耗。", 0],
    SeekerStrike: ["探寻打击", 1, "Attack", "造成9点伤害。 从抽牌堆的随机3张牌中选择一张加入你的手牌。", 0],
    Shockwave: ["震荡波", 2, "Skill", "给予所有敌人3层虚弱和易伤。 消耗。", 0],
    Splash: ["飞溅", 1, "Skill", "从3张其他角色的攻击牌中选择1张加入你的手牌。这张牌在本回合免费打出。", 0],
    Stratagem: ["计策", 1, "Power", "每当你的抽牌堆打乱洗牌时，选择一张牌放入你的手牌。", 0],
    TheBomb: ["炸弹", 2, "Skill", "在3回合结束后，对所有敌人造成40点伤害。", 0],
    TheGambit: ["孤注一掷", 0, "Skill", "获得50点格挡。 如果你在本场战斗中受到未被格挡的攻击伤害，则立刻死亡。", 0],
    ThinkingAhead: ["深谋远虑", 0, "Skill", "抽2张牌。 将手牌中的一张牌放到你的抽牌堆的顶端。 消耗。", 0],
    ThrummingHatchet: ["无休手斧", 1, "Attack", "造成11点伤害。 在你的下个回合开始时，将此卡返回你的手牌。", 0],
    UltimateDefend: ["究极防御", 1, "Skill", "获得11点格挡。", 0],
    UltimateStrike: ["究极打击", 1, "Attack", "造成14点伤害。", 0],
    Volley: ["连射", -1, "Attack", "随机对敌人造成10点伤害X次。", 0],
    AscendersBane: ["进阶之灾", -1, "Curse", "不能被打出。 虚无。 永恒。", 0],
    BadLuck: ["霉运", -1, "Curse", "不能被打出。 在你的回合结束时，如果这张牌在你的手牌中，你失去13点生命。 永恒。", 0],
    Clumsy: ["笨拙", -1, "Curse", "不能被打出。 虚无。", 0],
    CurseOfTheBell: ["铃铛的诅咒", -1, "Curse", "不能被打出。 永恒。", 0],
    Debt: ["债务", -1, "Curse", "不能被打出。 在你的回合结束时，如果这张牌在你的手牌中，你失去10金币。", 0],
    Decay: ["腐朽", -1, "Curse", "不能被打出。 在你的回合结束时，如果这张牌在你的手牌中, 你受到2点伤害。", 0],
    Doubt: ["疑虑", -1, "Curse", "不能被打出。 在你的回合结束时，如果这张牌在你的手牌中，获得1层虚弱。", 0],
    Enthralled: ["执迷", 2, "Curse", "如果这张牌在你的手牌中，你必须优先打出这张牌。 永恒。", 0],
    Folly: ["愚行", -1, "Curse", "不能被打出。 固有。 虚无。 永恒。", 0],
    Greed: ["贪婪", -1, "Curse", "不能被打出。 永恒。", 0],
    Guilty: ["愧疚", -1, "Curse", "不能被打出。 在5场战斗后从你的牌组中移除。", 0],
    Injury: ["受伤", -1, "Curse", "不能被打出。", 0],
    Normality: ["凡庸", -1, "Curse", "不能被打出。 你在本回合不能打出超过3张牌。", 0],
    PoorSleep: ["睡眠不佳", -1, "Curse", "不能被打出。 保留。", 0],
    Regret: ["悔恨", -1, "Curse", "不能被打出。 在你的回合结束时，如果这张牌在你的手牌中，失去相当于手牌数量的生命。", 0],
    Shame: ["羞耻", -1, "Curse", "不能被打出。 在你的回合结束时，如果这张牌在你的手牌中，则获得1层脆弱。", 0],
    SporeMind: ["孢子心灵", 1, "Curse", "消耗。", 0],
    Writhe: ["苦恼", -1, "Curse", "不能被打出。 固有。", 0],
    DeprecatedCard: ["弃用卡牌", 0, "Status", "这张卡牌在近期的一次更新中被移除。 抽1张牌。 将这张牌从你的牌组中移除。 消耗。", 0],
    Abundance: ["富足", 1, "Skill", "从3张升级过的能力牌中选择1张加入你的手牌。这张牌在本回合可以免费打出。 消耗。", 0],
    Apotheosis: ["神化", 2, "Skill", "固有。 升级你的全部卡牌。 消耗。", 0],
    Apparition: ["灵体", 1, "Skill", "虚无。 获得1层无实体。 消耗。", 0],
    BrightestFlame: ["至亮之焰", 0, "Skill", "获得2点能量。 抽2张牌。 失去2点最大生命。", 0],
    ByrdSwoop: ["异鸟扑击", 0, "Attack", "造成14点伤害。", 0],
    Caltrops: ["铁蒺藜", 1, "Power", "每当你被攻击时，对攻击者造成3点伤害。", 0],
    Clash: ["交锋", 0, "Attack", "只有在手牌中每一张牌都是攻击牌时才能被打出。 造成14点伤害。", 0],
    Distraction: ["声东击西", 1, "Skill", "将一张随机技能牌添加到你的手牌中。这张牌在本回合内可以免费打出。 消耗。", 0],
    DualWield: ["双持", 1, "Skill", "选择一张攻击牌或能力牌。将该牌的一张复制品加入你的手牌。", 0],
    Enlightenment: ["开悟", 0, "Skill", "在这个回合，你当前手牌中所有牌的耗能降低至1。 消耗。", 0],
    Entrench: ["巩固", 2, "Skill", "将你当前的格挡翻倍。", 0],
    Exterminate: ["杀灭", 1, "Attack", "对所有敌人造成3点伤害4次。", 0],
    FeedingFrenzy: ["疯狂进食", 0, "Skill", "在本回合内获得5点力量。", 0],
    HelloWorld: ["你好世界", 1, "Power", "在你的回合开始时，将一张随机普通牌加入你的手牌。", 0],
    MadScience: ["疯狂科学", 1, "None", "？？？？？？", 0],
    Maul: ["撕咬", 1, "Attack", "造成5点伤害两次。 在这场战斗中，将所有“撕咬”牌的伤害增加2。", 0],
    Metamorphosis: ["羽化", 2, "Skill", "在你的抽牌堆中加入3张随机攻击牌。它们在本场战斗中可以被免费打出。 消耗。", 0],
    NeowsFury: ["涅奥之怒", 1, "Attack", "造成10点伤害。 将你弃牌堆中的至多2张牌放入你的手牌。 消耗。", 0],
    Outmaneuver: ["抢占先机", 1, "Skill", "在下个回合获得2点能量。", 0],
    Peck: ["啄击", 1, "Attack", "造成2点伤害3次。", 0],
    Rebound: ["弹回", 1, "Attack", "造成9点伤害。 将你在本回合打出的下一张牌放置到你的抽牌堆顶部。", 0],
    Relax: ["放松", 3, "Skill", "获得16点格挡。 下个回合，抽2张牌并获得2点能量。 消耗。", 0],
    RipAndTear: ["狂乱撕扯", 1, "Attack", "随机对敌人造成7点伤害两次。", 0],
    Squash: ["压扁", 1, "Attack", "造成10点伤害。 给予2层易伤。", 0],
    Stack: ["堆栈", 1, "Skill", "获得等量于与你当前弃牌堆中牌数的格挡值。", 0],
    ToricToughness: ["坚韧之环", 2, "Skill", "获得5点格挡。 在接下来的2个回合开始时，获得5点格挡。", 0],
    Wish: ["许愿", 0, "Skill", "将你抽牌堆中的一张牌放入你的手牌。 消耗。", 0],
    Whistle: ["吹哨", 2, "Attack", "造成33点伤害。 击晕该敌人。 消耗。", 0],
    ByrdonisEgg: ["多尼斯异鸟蛋", -1, "Quest", "不能被打出。 能在休息处被孵化。", 0],
    Dowsing: ["探寻", -1, "Quest", "不能被打出。 在进入5个?房间后，这张牌变化为富足。", 0],
    LanternKey: ["灯火钥匙", -1, "Quest", "不能被打出。 在下一阶段解锁一个特殊事件。", 0],
    SpoilsMap: ["藏宝图", -1, "Quest", "不能被打出。 在下一阶段的地图上，标记一个有600额外金币的地点。", 0],
    Beckon: ["呼唤", 1, "Status", "在你的回合结束时，如果这张牌在你的手牌中， 你失去6点生命。", 0],
    Burn: ["灼伤", -1, "Status", "不能被打出。 在你的回合结束时，如果这张牌在你的手牌中，你受到2点伤害。", 0],
    Dazed: ["晕眩", -1, "Status", "不能被打出。 虚无。", 0],
    Debris: ["碎屑", 1, "Status", "消耗。", 0],
    FranticEscape: ["狂乱逃离", 1, "Status", "远离。 将沙坑的计数加1。 这张牌的耗能加1。", 0],
    Infection: ["感染", -1, "Status", "不能被打出。 在你的回合结束时，如果这张牌在你的手牌中，你受到3点伤害。", 0],
    Wither: ["凋萎", -1, "Status", "不能被打出。 在你的回合结束时，如果这张牌在你的手牌中，你受到3点伤害。", 0],
    Slimed: ["黏液", 1, "Status", "抽1张牌。 消耗。", 0],
    Soot: ["煤灰", -1, "Status", "不能被打出。", 0],
    Toxic: ["毒素", 1, "Status", "在你的回合结束时，如果这张牌在你的手牌中，你受到5点伤害。 消耗。", 0],
    Void: ["虚空", -1, "Status", "不能被打出。 虚无。 每当你抽到这张牌时，失去1点能量。", 0],
    Wound: ["伤口", -1, "Status", "不能被打出。", 0],
    Disintegration: ["瓦解", -1, "Status", "在你的回合结束时，受到6点伤害。", 0],
    Fuel: ["燃料", 0, "Skill", "获得1点能量。 消耗。", 0],
    GiantRock: ["巨石", 1, "Attack", "造成20点伤害。", 0],
    Luminesce: ["冷光", 0, "Skill", "保留。 获得2点能量。 消耗。", 0],
    MindRot: ["心灵腐化", -1, "Status", "每回合少抽1张牌。", 0],
    MinionDiveBomb: ["仆从俯冲", 0, "Attack", "造成13点伤害。 消耗。", 0],
    MinionSacrifice: ["仆从捐躯", 0, "Skill", "获得7点格挡。 消耗。", 0],
    MinionStrike: ["仆从打击", 0, "Attack", "造成6点伤害。 抽1张牌。 消耗。", 0],
    Shiv: ["小刀", 0, "Attack", "造成4点伤害。 消耗。", 0],
    Sloth: ["懒惰", -1, "Status", "你在每个回合不能打出超过3张牌。", 0],
    Soul: ["灵魂", 0, "Skill", "抽2张牌。 消耗。", 0],
    SovereignBlade: ["君王之剑", 2, "Attack", "保留。 造成10点伤害。", 0],
    SweepingGaze: ["扫荡凝视", 0, "Attack", "虚无。 奥斯提对随机一名敌人造成10点伤害。 消耗。", 0],
    WasteAway: ["衰朽", -1, "Status", "每回合失去1点1点能量。", 0],
};
// Effects are applied in play order. Each hit is resolved against current block.
const DUEL_EFFECTS = {
    Rampage: { hit: 9, damageAfterPlay: 5 },
    Flechettes: { hit: 5, hits: (_actor, _target, hand) => hand.filter((card) => GAME_CARDS[card.id][2] === "Skill").length },
    PhotonCut: { hit: 10, draw: 1, putBack: true },
    Conqueror: { forge: 3, doubleBlade: true },
    Refract: { hit: 9, hits: () => 2, orbs: ["glass", "glass"] },
    Bully: { hit: (_, t) => 4 + 2 * t.vulnerable },
    CrimsonMantle: { mantle: 8 },
    Cruelty: { cruelty: 0.25 },
    Dominate: { vulnerable: 1, strengthFromVulnerable: true, exhaust: true },
    DrumOfBattle: { draw: 2, exhaustEnergy: 2 },
    Mangle: { hit: 15, enemyStrengthLoss: 10 },
    NotYet: { heal: 10, exhaust: true },
    SetupStrike: { hit: 7, temporaryStrength: 2 },
    Unrelenting: { hit: 14, freeAttack: true },
    Whirlwind: { hit: 5, xEnergy: true },
    Abrasive: { dexterity: 1, thorns: 4, sly: true },
    Accelerant: { extraPoisonTicks: 1 },
    Blur: { keepBlockNext: true, block: 5 },
    Envenom: { envenom: 1 },
    GrandFinale: { hit: 60, emptyDeck: true },
    MementoMori: { hit: (a) => 9 + 4 * a.discardedThisRound },
    Murder: { hit: (a) => 1 + a.totalDrawn },
    PiercingWail: { enemyStrengthLoss: 6, exhaust: true },
    Shadowmeld: { doubleBlock: true },
    Skewer: { hit: 8, xEnergy: true },
    BlackHole: { blackHole: 3 },
    ChildOfTheStars: { blockPerStar: 2 },
    Convergence: { retainHand: true, nextEnergy: 1, nextStars: 1 },
    CrashLanding: { hit: 21, fillDebris: true },
    Monologue: { strengthOnPlay: 1 },
    NeutronAegis: { plating: 8 },
    Parry: { parry: 10 },
    Radiate: { hit: 3, hits: (a) => a.starsGained },
    SeekingEdge: { forge: 7 },
    Stardust: { hit: 5, xEnergy: true },
    BorrowedTime: { energy: 4, extraCost: 1 },
    DeathMarch: { hit: (a) => 8 + 4 * a.extraDrawn },
    DevourLife: { summonOnSoul: 1 },
    Dirge: { xEnergy: true, summonPerEnergy: 3, soulsPerEnergy: 1, exhaust: true },
    EnfeeblingTouch: { enemyStrengthLoss: 8, ethereal: true },
    Friendship: { strength: -2, energyPerRound: 1 },
    Haunt: { lossOnSoul: 6 },
    Parse: { draw: 3, ethereal: true },
    Rattle: { hit: 7, osty: true, hits: (a) => 1 + a.ostyHits },
    Undeath: { block: 7, addToDiscard: 'Undeath' },
    BulkUp: { orbSlots: -1, strength: 2, dexterity: 2 },
    Buffer: { buffer: 1 },
    Coolant: { coolant: 2 },
    Fusion: { orb: 'plasma', exhaust: true },
    Glasswork: { block: 5, orb: 'glass' },
    Loop: { loop: 1 },
    Modded: { orbSlots: 1, draw: 1, discountAfterPlay: -1 },
    MomentumStrike: { hit: 10, discountAfterPlay: 1 },
    MultiCast: { evoke: true, xEnergy: true },
    Tempest: { xEnergy: true, lightningPerEnergy: true },
    Brand: { hpLoss: 1, exhaustHand: 1, strength: 1 },
    BurningPact: { exhaustHand: 1, draw: 2 },
    TrueGrit: { block: 7, exhaustHand: 'random' },
    FeelNoPain: { blockOnExhaust: 3 },
    DarkEmbrace: { drawOnExhaust: 1 },
    EvilEye: { block: 8, blockIfExhausted: 8 },
    ForgottenRitual: { energyIfExhausted: 3, exhaust: true },
    Cinder: { hit: 18, exhaustHand: 'random' },
    PactsEnd: { hit: (actor) => actor.exhausted >= 3 ? 17 : 0 },
    SecondWind: { exhaustHand: 'nonAttack', blockPerExhaust: 5 },
    Mirage: { block: (_actor, target) => target.poison, exhaust: true },
    Pounce: { hit: 14, freeSkill: true },
    Prepared: { draw: 1, discard: true },
    Ricochet: { hit: 3, hits: () => 4, sly: true },
    Untouchable: { block: 6, sly: true },
    UpMySleeve: { shivs: 3, discountAfterPlay: 1 },
    Haze: { poison: 4, sly: true },
    FlickFlack: { hit: 6, sly: true },
    Anticipate: { temporaryDexterity: 2 },
    Tracking: { tracking: true },
    Bulwark: { block: 12, forge: 10 },
    BigBang: { draw: 1, energy: 1, stars: 1, forge: 5, exhaust: true },
    Furnace: { forgePerRound: 5 },
    RefineBlade: { forge: 9, nextEnergy: 1 },
    SpoilsOfBattle: { forge: 5, draw: 2 },
    TheSmith: { forge: 30 },
    WroughtInWar: { hit: 7, forge: 7 },
    Patter: { block: 8, vigor: 2 },
    Terraforming: { vigor: 6 },
    TheSealedThrone: { starsOnPlay: 1 },
    Cleanse: { summon: 3, exhaustDrawTop: true },
    DeathsDoor: { block: 6, repeatBlockOnDoom: 2 },
    Dredge: { recoverToHand: 3, exhaust: true },
    Eradicate: { hit: 11, xEnergy: true, retain: true },
    Graveblast: { hit: 4, recoverToHand: 1, exhaust: true },
    Invoke: { nextSummon: 2, nextEnergy: 2 },
    NoEscape: { doom: (_actor, target) => 10 + 5 * Math.floor(target.doom / 10) },
    Oblivion: { doomOnPlay: 3 },
    Seance: { transformDrawTop: 'Soul', ethereal: true },
    Severance: { hit: 13, souls: 1, addToHand: 'Soul', addToDiscard: 'Soul' },
    Defragment: { focus: 1 },
    Hotfix: { temporaryFocus: 2, exhaust: true },
    FocusedStrike: { hit: 9, temporaryFocus: 1 },
    Hyperbeam: { hit: 28, focus: -3 },
    Synchronize: { temporaryFocus: (actor) => 2 * new Set(actor.orbs.map((orb) => orb.kind)).size, exhaust: true },
    FightThrough: { block: 13, addToDiscard: 'Wound', discardCopies: 2 },
    Overclock: { draw: 2, addToDiscard: 'Burn' },
    Hailstorm: { hailstorm: 6 },
    LightningRod: { block: 4, lightningRounds: 2 },
    TeslaCoil: { hit: 3, triggerLightning: true },
    SovereignBlade: { hit: (actor) => 10 + actor.bladeForge, retain: true },
    Wound: { unplayable: true },
    Burn: { unplayable: true, endHandDamage: 2 },
    AshenStrike: { hit: (actor) => 6 + 3 * actor.exhausted, exhaust: true },
    Barricade: { keepBlock: true },
    BattleTrance: { draw: 3, stopDraw: true },
    BloodWall: { hpLoss: 2, block: 16 },
    Bloodletting: { hpLoss: 3, energy: 2 },
    Break: { hit: 20, vulnerable: 5 },
    Breakthrough: { hpLoss: 1, hit: 9 },
    DemonForm: { strengthPerRound: 2 },
    Dismantle: { hit: 8, hits: (_actor, target) => target.vulnerable ? 2 : 1 },
    Hemokinesis: { hpLoss: 2, hit: 15 },
    MoltenFist: { hit: 10, doubleVulnerable: true, exhaust: true },
    Offering: { hpLoss: 6, energy: 2, draw: 3, exhaust: true },
    Pyre: { energyPerRound: 1 },
    SwordBoomerang: { hit: 3, hits: () => 3 },
    Afterimage: { afterimage: 1 },
    Assassinate: { hit: 10, vulnerable: 1, innate: true, exhaust: true },
    BubbleBubble: { poison: (_actor, target) => target.poison ? 9 : 0 },
    Finisher: { hit: 6, hits: (actor) => actor.played.Attack },
    LeadingStrike: { hit: 3, shivs: 2 },
    Suppress: { hit: 11, weak: 3, innate: true },
    Predator: { hit: 15, nextDraw: 2 },
    Snakebite: { poison: 7, retain: true },
    CollisionCourse: { hit: 11, addToHand: 'Debris' },
    CosmicIndifference: { block: 6, recoverDiscard: true },
    CrescentSpear: { hit: (actor) => 8 + 2 * actor.starCards },
    CrushUnder: { hit: 7, enemyStrengthLoss: 1 },
    DyingStar: { hit: 9, enemyStrengthLoss: 9, ethereal: true },
    Glitterstream: { block: 11, nextBlock: 5 },
    Hegemony: { hit: 15, nextEnergy: 2 },
    KinglyKick: { hit: 27, discountOnDraw: 1 },
    KinglyPunch: { hit: 8, damageOnDraw: 4 },
    MeteorShower: { hit: 14, weak: 2, vulnerable: 2 },
    Resonance: { strength: 1, permanentEnemyStrengthLoss: 1 },
    Bury: { hit: 52 },
    CaptureSpirit: { directLoss: 3, souls: 3 },
    Countdown: { doomPerRound: 6 },
    Defile: { hit: 13, ethereal: true },
    Defy: { block: 6, weak: 1, ethereal: true },
    Delay: { block: 11, nextEnergy: 1 },
    Demesne: { energyPerRound: 1, drawPerRound: 1, ethereal: true },
    Fear: { hit: 7, vulnerable: 1, ethereal: true },
    Putrefy: { weak: 2, vulnerable: 2, exhaust: true },
    TimesUp: { hit: (_actor, target) => target.doom, exhaust: true },
    Barrage: { hit: 5, hits: (actor) => actor.orbs.length },
    ChargeBattery: { block: 7, nextEnergy: 1 },
    Chill: { orb: 'frost', exhaust: true },
    Claw: { hit: (actor) => 3 + actor.clawDamage, clawDamage: 2 },
    DoubleEnergy: { doubleEnergy: true, exhaust: true },
    Glacier: { orbs: ['frost', 'frost'], block: 6 },
    Hologram: { block: 3, recoverToHand: true, exhaust: true },
    IceLance: { hit: 19, orbs: ['frost', 'frost', 'frost'] },
    MachineLearning: { drawPerRound: 1 },
    Null: { hit: 10, weak: 2, orb: 'dark' },
    Quadcast: { evoke: 4 },
    Rainbow: { orbs: ['lightning', 'frost', 'dark'], exhaust: true },
    Synthesis: { freePower: true, hit: 14 },
    Debris: { exhaust: true },
    Anger: { hit: 6, addToDiscard: "Anger" },
    DeadlyPoison: { poison: 5 },
    PoisonedStab: { hit: 6, poison: 3 },
    BouncingFlask: { poison: 9 },
    NoxiousFumes: { poisonPerRound: 2 },
    ShiningStrike: { hit: 8, stars: 2, returnToTop: true },
    Scourge: { doom: 13, draw: 1 },
    NegativePulse: { block: 5, doom: 7 },
    Deathbringer: { doom: 21, weak: 1 },
    BlightStrike: { hit: 8, doomOnHit: true },
    Darkness: { orb: "dark" },
    ShadowShield: { block: 11, orb: "dark" },
    Uppercut: { hit: 13, weak: 1, vulnerable: 1 },
    Headbutt: { hit: 9, recoverDiscard: true },
    Backstab: { hit: 11, innate: true, exhaust: true },
    DodgeAndRoll: { block: 4, repeatBlockNextRound: true },
    HiddenCache: { stars: 1, nextStars: 3 },
    Glow: { stars: 1, draw: 1, nextDraw: 1 },
    Flatten: { hit: 12, osty: true, freeAfterOsty: true },
    BoneShards: { hit: 9, osty: true, block: 9, sacrificeOsty: true },
    BootSequence: { block: 10, innate: true, exhaust: true },
    Ftl: { hit: 5, draw: (actor) => actor.played.Attack + actor.played.Skill + actor.played.Power < 3 ? 1 : 0 },
    Turbo: { energy: 2, addToDiscard: "Void" },
    Void: { unplayable: true, ethereal: true, energyLossOnDraw: 1 },
    BladeDance: { shivs: 3, exhaust: true },
    CloakAndDagger: { block: 6, shivs: 1 },
    Accuracy: { shivDamage: 4 },
    InfiniteBlades: { shivsPerRound: 1 },
    Reave: { hit: 9, souls: 1 },
    GraveWarden: { block: 8, souls: 1 },
    SoulStorm: { hit: (actor) => 9 + 2 * actor.exhaustedSouls },
    BoostAway: { block: 6, dazed: true },
    Shiv: { hit: (actor) => 4 + actor.shivDamage, exhaust: true },
    Soul: { draw: 2, exhaust: true },
    Dazed: { unplayable: true, ethereal: true },
    Capacitor: { orbSlots: 2 },
    Calcify: { ostyDamage: 4 },
    Genesis: { starsPerRound: 2 },
    Footwork: { dexterity: 2 },
    Inflame: { strength: 2 },
    Conflagration: { hit: 2, hits: () => 4 },
    Impervious: { block: 30, exhaust: true },
    Tremble: { vulnerable: 3, exhaust: true },
    Acrobatics: { draw: 3, discard: true },
    Alignment: { energy: 2 },
    AstralPulse: { hit: 6, hits: () => 2 },
    CelestialMight: { hit: 6, hits: () => 3 },
    GuidingStar: { hit: 12, draw: 2 },
    KnowThyPlace: { weak: 1, vulnerable: 1, exhaust: true },
    Prophesize: { draw: 6 },
    RoyalGamble: { stars: 9, exhaust: true },
    SevenStars: { hit: 7, hits: () => 7 },
    Reap: { hit: 27, retain: true },
    Sow: { hit: 8, retain: true },
    Wisp: { energy: 1, exhaust: true },
    Coolheaded: { orb: "frost", draw: 1 },
    Supercritical: { energy: 4, exhaust: true },
    ShrugItOff: { block: 8, draw: 1 },
    Thunderclap: { hit: 4, vulnerable: 1 },
    DaggerSpray: { hit: 4, hits: () => 2 },
    DaggerThrow: { hit: 9, draw: 1, discard: true },
    GatherLight: { block: 8, stars: 1 },
    SolarStrike: { hit: 9, stars: 1 },
    Poke: { hit: 6, osty: true },
    HighFive: { hit: 11, osty: true, vulnerable: 2 },
    CompileDriver: { hit: 7, draw: (actor) => new Set(actor.orbs.map((orb) => orb.kind)).size },
    SweepingBeam: { hit: 6, draw: 1 },
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
    if (id.endsWith("+")) return DUEL_EFFECTS[id];
    if (id.startsWith("Strike")) return { hit: 6 };
    if (id.startsWith("Defend")) return { block: 5 };
    return DUEL_EFFECTS[id];
}

const ORIGINAL_UPGRADES = {
    "Abrasive": [
        [
            "effect",
            "thorns",
            2
        ]
    ],
    "Accelerant": [
        [
            "effect",
            "extraPoisonTicks",
            1
        ]
    ],
    "Accuracy": [
        [
            "effect",
            "shivDamage",
            2
        ]
    ],
    "Acrobatics": [
        [
            "effect",
            "draw",
            1
        ]
    ],
    "Adrenaline": [
        [
            "effect",
            "energy",
            1
        ]
    ],
    "Afterimage": [
        [
            "keyword",
            "innate",
            true
        ]
    ],
    "Afterlife": [
        [
            "effect",
            "summon",
            3
        ]
    ],
    "Alignment": [
        [
            "effect",
            "energy",
            1
        ]
    ],
    "Anger": [
        [
            "effect",
            "hit",
            2
        ]
    ],
    "Anticipate": [
        [
            "effect",
            "dexterity",
            1
        ]
    ],
    "Assassinate": [
        [
            "effect",
            "hit",
            3
        ],
        [
            "effect",
            "vulnerable",
            1
        ]
    ],
    "AstralPulse": [
        [
            "effect",
            "hit",
            2
        ]
    ],
    "Backflip": [
        [
            "effect",
            "block",
            3
        ]
    ],
    "Backstab": [
        [
            "effect",
            "hit",
            4
        ]
    ],
    "BallLightning": [
        [
            "effect",
            "hit",
            3
        ]
    ],
    "Barrage": [
        [
            "effect",
            "hit",
            2
        ]
    ],
    "Barricade": [
        [
            "cost",
            "",
            -1
        ]
    ],
    "Bash": [
        [
            "effect",
            "hit",
            2
        ],
        [
            "effect",
            "vulnerable",
            1
        ]
    ],
    "BattleTrance": [
        [
            "effect",
            "draw",
            1
        ]
    ],
    "BeamCell": [
        [
            "effect",
            "hit",
            1
        ],
        [
            "effect",
            "vulnerable",
            1
        ]
    ],
    "BigBang": [
        [
            "keyword",
            "innate",
            true
        ]
    ],
    "BlackHole": [
        [
            "effect",
            "blackHole",
            1
        ]
    ],
    "BladeDance": [
        [
            "effect",
            "draw",
            1
        ]
    ],
    "BlightStrike": [
        [
            "effect",
            "hit",
            2
        ]
    ],
    "BloodWall": [
        [
            "effect",
            "block",
            4
        ]
    ],
    "Bloodletting": [
        [
            "effect",
            "energy",
            1
        ]
    ],
    "Bludgeon": [
        [
            "effect",
            "hit",
            10
        ]
    ],
    "Blur": [
        [
            "effect",
            "block",
            3
        ]
    ],
    "BodySlam": [
        [
            "cost",
            "",
            -1
        ]
    ],
    "Bodyguard": [
        [
            "effect",
            "summon",
            2
        ]
    ],
    "BoneShards": [
        [
            "effect",
            "hit",
            3
        ],
        [
            "effect",
            "block",
            3
        ]
    ],
    "BoostAway": [
        [
            "effect",
            "block",
            3
        ]
    ],
    "BootSequence": [
        [
            "effect",
            "block",
            3
        ]
    ],
    "BorrowedTime": [
        [
            "effect",
            "energy",
            2
        ]
    ],
    "Brand": [
        [
            "effect",
            "strength",
            1
        ]
    ],
    "Breakthrough": [
        [
            "effect",
            "hit",
            4
        ]
    ],
    "BubbleBubble": [
        [
            "effect",
            "poison",
            3
        ]
    ],
    "Buffer": [
        [
            "effect",
            "buffer",
            1
        ]
    ],
    "BulkUp": [
        [
            "effect",
            "strength",
            1
        ],
        [
            "effect",
            "dexterity",
            1
        ]
    ],
    "Bulwark": [
        [
            "effect",
            "block",
            3
        ],
        [
            "effect",
            "forge",
            3
        ]
    ],
    "BurningPact": [
        [
            "effect",
            "draw",
            1
        ]
    ],
    "Bury": [
        [
            "effect",
            "hit",
            11
        ]
    ],
    "Calcify": [
        [
            "effect",
            "ostyDamage",
            2
        ]
    ],
    "CaptureSpirit": [
        [
            "effect",
            "hit",
            1
        ],
        [
            "effect",
            "draw",
            1
        ]
    ],
    "ChargeBattery": [
        [
            "effect",
            "block",
            3
        ]
    ],
    "ChildOfTheStars": [
        [
            "effect",
            "blockPerStar",
            1
        ]
    ],
    "Chill": [
        [
            "keyword",
            "exhaust",
            false
        ]
    ],
    "Cinder": [
        [
            "effect",
            "hit",
            6
        ]
    ],
    "Cleanse": [
        [
            "effect",
            "summon",
            2
        ]
    ],
    "CloakAndDagger": [
        [
            "effect",
            "draw",
            1
        ]
    ],
    "CloakOfStars": [
        [
            "effect",
            "block",
            3
        ]
    ],
    "ColdSnap": [
        [
            "effect",
            "hit",
            3
        ]
    ],
    "CollisionCourse": [
        [
            "effect",
            "hit",
            4
        ]
    ],
    "Comet": [
        [
            "effect",
            "hit",
            11
        ]
    ],
    "CompileDriver": [
        [
            "effect",
            "hit",
            3
        ]
    ],
    "Conqueror": [
        [
            "effect",
            "forge",
            2
        ]
    ],
    "Convergence": [
        [
            "effect",
            "stars",
            1
        ]
    ],
    "Coolant": [
        [
            "effect",
            "coolant",
            1
        ]
    ],
    "Coolheaded": [
        [
            "effect",
            "draw",
            1
        ]
    ],
    "CosmicIndifference": [
        [
            "effect",
            "block",
            3
        ]
    ],
    "Countdown": [
        [
            "effect",
            "doomPerRound",
            3
        ]
    ],
    "CrashLanding": [
        [
            "effect",
            "hit",
            5
        ]
    ],
    "CrimsonMantle": [
        [
            "effect",
            "mantle",
            2
        ]
    ],
    "Cruelty": [
        [
            "effect",
            "cruelty",
            25
        ]
    ],
    "DaggerSpray": [
        [
            "effect",
            "hit",
            2
        ]
    ],
    "DaggerThrow": [
        [
            "effect",
            "hit",
            3
        ]
    ],
    "DarkEmbrace": [
        [
            "cost",
            "",
            -1
        ]
    ],
    "Dash": [
        [
            "effect",
            "hit",
            3
        ],
        [
            "effect",
            "block",
            3
        ]
    ],
    "DeadlyPoison": [
        [
            "effect",
            "poison",
            2
        ]
    ],
    "Deathbringer": [
        [
            "effect",
            "doom",
            5
        ]
    ],
    "DeathsDoor": [
        [
            "effect",
            "block",
            1
        ]
    ],
    "DefendDefect": [
        [
            "effect",
            "block",
            3
        ]
    ],
    "DefendIronclad": [
        [
            "effect",
            "block",
            3
        ]
    ],
    "DefendNecrobinder": [
        [
            "effect",
            "block",
            3
        ]
    ],
    "DefendRegent": [
        [
            "effect",
            "block",
            3
        ]
    ],
    "DefendSilent": [
        [
            "effect",
            "block",
            3
        ]
    ],
    "Defile": [
        [
            "effect",
            "hit",
            4
        ]
    ],
    "Deflect": [
        [
            "effect",
            "block",
            3
        ]
    ],
    "Defragment": [
        [
            "effect",
            "focus",
            1
        ]
    ],
    "Defy": [
        [
            "effect",
            "block",
            3
        ]
    ],
    "Delay": [
        [
            "effect",
            "block",
            2
        ],
        [
            "effect",
            "energy",
            1
        ]
    ],
    "Demesne": [
        [
            "cost",
            "",
            -1
        ]
    ],
    "DemonForm": [
        [
            "effect",
            "strength",
            1
        ]
    ],
    "Devastate": [
        [
            "effect",
            "hit",
            10
        ]
    ],
    "DevourLife": [
        [
            "effect",
            "summonOnSoul",
            1
        ]
    ],
    "Dirge": [
        [
            "effect",
            "summon",
            1
        ]
    ],
    "Dismantle": [
        [
            "effect",
            "hit",
            2
        ]
    ],
    "DodgeAndRoll": [
        [
            "effect",
            "block",
            2
        ]
    ],
    "Dominate": [
        [
            "effect",
            "vulnerable",
            1
        ]
    ],
    "DoubleEnergy": [
        [
            "cost",
            "",
            -1
        ]
    ],
    "Dredge": [
        [
            "keyword",
            "retain",
            true
        ]
    ],
    "DrumOfBattle": [
        [
            "effect",
            "energy",
            1
        ]
    ],
    "Dualcast": [
        [
            "cost",
            "",
            -1
        ]
    ],
    "Envenom": [
        [
            "effect",
            "envenom",
            1
        ]
    ],
    "Eradicate": [
        [
            "effect",
            "hit",
            3
        ]
    ],
    "EvilEye": [
        [
            "effect",
            "block",
            3
        ]
    ],
    "FallingStar": [
        [
            "effect",
            "hit",
            4
        ]
    ],
    "Fear": [
        [
            "effect",
            "hit",
            1
        ],
        [
            "effect",
            "vulnerable",
            1
        ]
    ],
    "Fetch": [
        [
            "effect",
            "hit",
            3
        ]
    ],
    "FightThrough": [
        [
            "effect",
            "block",
            4
        ]
    ],
    "Finisher": [
        [
            "effect",
            "hit",
            2
        ]
    ],
    "Flatten": [
        [
            "effect",
            "hit",
            4
        ]
    ],
    "Flechettes": [
        [
            "effect",
            "hit",
            2
        ]
    ],
    "FlickFlack": [
        [
            "effect",
            "hit",
            2
        ]
    ],
    "FocusedStrike": [
        [
            "effect",
            "hit",
            2
        ],
        [
            "effect",
            "focus",
            1
        ]
    ],
    "Footwork": [
        [
            "effect",
            "dexterity",
            1
        ]
    ],
    "ForgottenRitual": [
        [
            "effect",
            "energy",
            1
        ]
    ],
    "Friendship": [
        [
            "effect",
            "strength",
            -1
        ]
    ],
    "Furnace": [
        [
            "effect",
            "forge",
            2
        ]
    ],
    "Fusion": [
        [
            "keyword",
            "exhaust",
            false
        ]
    ],
    "GammaBlast": [
        [
            "effect",
            "hit",
            5
        ]
    ],
    "GatherLight": [
        [
            "effect",
            "block",
            3
        ]
    ],
    "Genesis": [
        [
            "effect",
            "starsPerRound",
            1
        ]
    ],
    "Glacier": [
        [
            "effect",
            "block",
            3
        ]
    ],
    "Glasswork": [
        [
            "effect",
            "block",
            3
        ]
    ],
    "Glitterstream": [
        [
            "effect",
            "block",
            2
        ],
        [
            "effect",
            "nextBlock",
            2
        ]
    ],
    "Glow": [
        [
            "effect",
            "stars",
            1
        ]
    ],
    "GoForTheEyes": [
        [
            "effect",
            "hit",
            1
        ],
        [
            "effect",
            "weak",
            1
        ]
    ],
    "GrandFinale": [
        [
            "effect",
            "hit",
            15
        ]
    ],
    "GraveWarden": [
        [
            "effect",
            "block",
            3
        ]
    ],
    "Graveblast": [
        [
            "effect",
            "hit",
            2
        ],
        [
            "keyword",
            "exhaust",
            false
        ]
    ],
    "GuidingStar": [
        [
            "effect",
            "hit",
            1
        ],
        [
            "effect",
            "draw",
            1
        ]
    ],
    "Hailstorm": [
        [
            "effect",
            "hailstorm",
            2
        ]
    ],
    "Haunt": [
        [
            "effect",
            "lossOnSoul",
            2
        ]
    ],
    "Haze": [
        [
            "effect",
            "poison",
            2
        ]
    ],
    "Headbutt": [
        [
            "effect",
            "hit",
            3
        ]
    ],
    "Hegemony": [
        [
            "effect",
            "hit",
            3
        ],
        [
            "effect",
            "energy",
            1
        ]
    ],
    "Hemokinesis": [
        [
            "effect",
            "hit",
            5
        ]
    ],
    "HiddenCache": [
        [
            "effect",
            "nextStars",
            1
        ]
    ],
    "HighFive": [
        [
            "effect",
            "hit",
            2
        ],
        [
            "effect",
            "vulnerable",
            1
        ]
    ],
    "Hologram": [
        [
            "effect",
            "block",
            2
        ],
        [
            "keyword",
            "exhaust",
            false
        ]
    ],
    "Hotfix": [
        [
            "keyword",
            "exhaust",
            false
        ]
    ],
    "Hyperbeam": [
        [
            "effect",
            "hit",
            8
        ]
    ],
    "IceLance": [
        [
            "effect",
            "hit",
            5
        ]
    ],
    "Impervious": [
        [
            "effect",
            "block",
            10
        ]
    ],
    "InfiniteBlades": [
        [
            "keyword",
            "innate",
            true
        ]
    ],
    "Inflame": [
        [
            "effect",
            "strength",
            1
        ]
    ],
    "Invoke": [
        [
            "effect",
            "summon",
            1
        ],
        [
            "effect",
            "energy",
            1
        ]
    ],
    "IronWave": [
        [
            "effect",
            "hit",
            2
        ],
        [
            "effect",
            "block",
            2
        ]
    ],
    "KinglyKick": [
        [
            "effect",
            "hit",
            8
        ]
    ],
    "KnowThyPlace": [
        [
            "keyword",
            "exhaust",
            false
        ]
    ],
    "LeadingStrike": [
        [
            "effect",
            "hit",
            3
        ]
    ],
    "Leap": [
        [
            "effect",
            "block",
            3
        ]
    ],
    "LegSweep": [
        [
            "effect",
            "block",
            3
        ],
        [
            "effect",
            "weak",
            1
        ]
    ],
    "LightningRod": [
        [
            "effect",
            "block",
            3
        ]
    ],
    "Loop": [
        [
            "effect",
            "loop",
            1
        ]
    ],
    "LunarBlast": [
        [
            "effect",
            "hit",
            1
        ]
    ],
    "MachineLearning": [
        [
            "keyword",
            "innate",
            true
        ]
    ],
    "Mirage": [
        [
            "cost",
            "",
            -1
        ]
    ],
    "Modded": [
        [
            "effect",
            "draw",
            1
        ]
    ],
    "MoltenFist": [
        [
            "effect",
            "hit",
            4
        ]
    ],
    "MomentumStrike": [
        [
            "effect",
            "hit",
            3
        ]
    ],
    "Monologue": [
        [
            "keyword",
            "retain",
            true
        ]
    ],
    "Murder": [
        [
            "cost",
            "",
            -1
        ]
    ],
    "NegativePulse": [
        [
            "effect",
            "block",
            1
        ],
        [
            "effect",
            "doom",
            4
        ]
    ],
    "Neutralize": [
        [
            "effect",
            "hit",
            1
        ],
        [
            "effect",
            "weak",
            1
        ]
    ],
    "NeutronAegis": [
        [
            "effect",
            "plating",
            3
        ]
    ],
    "NotYet": [
        [
            "effect",
            "heal",
            3
        ]
    ],
    "NoxiousFumes": [
        [
            "effect",
            "poisonPerRound",
            1
        ]
    ],
    "Null": [
        [
            "effect",
            "hit",
            3
        ],
        [
            "effect",
            "weak",
            1
        ]
    ],
    "Oblivion": [
        [
            "effect",
            "doom",
            1
        ]
    ],
    "Offering": [
        [
            "effect",
            "draw",
            2
        ]
    ],
    "Overclock": [
        [
            "effect",
            "draw",
            1
        ]
    ],
    "PactsEnd": [
        [
            "effect",
            "hit",
            6
        ]
    ],
    "Parry": [
        [
            "effect",
            "parry",
            4
        ]
    ],
    "Parse": [
        [
            "effect",
            "draw",
            1
        ]
    ],
    "Patter": [
        [
            "effect",
            "block",
            2
        ],
        [
            "effect",
            "vigor",
            1
        ]
    ],
    "PhotonCut": [
        [
            "effect",
            "hit",
            3
        ],
        [
            "effect",
            "draw",
            1
        ]
    ],
    "Pinpoint": [
        [
            "effect",
            "hit",
            4
        ]
    ],
    "PoisonedStab": [
        [
            "effect",
            "hit",
            2
        ],
        [
            "effect",
            "poison",
            1
        ]
    ],
    "Poke": [
        [
            "effect",
            "hit",
            3
        ]
    ],
    "PommelStrike": [
        [
            "effect",
            "hit",
            1
        ],
        [
            "effect",
            "draw",
            1
        ]
    ],
    "Pounce": [
        [
            "effect",
            "hit",
            6
        ]
    ],
    "Predator": [
        [
            "effect",
            "hit",
            5
        ]
    ],
    "Prepared": [
        [
            "effect",
            "draw",
            1
        ]
    ],
    "Prophesize": [
        [
            "effect",
            "draw",
            3
        ]
    ],
    "PullAggro": [
        [
            "effect",
            "summon",
            1
        ],
        [
            "effect",
            "block",
            2
        ]
    ],
    "Pyre": [
        [
            "effect",
            "energy",
            1
        ]
    ],
    "Radiate": [
        [
            "effect",
            "hit",
            1
        ]
    ],
    "Rainbow": [
        [
            "keyword",
            "exhaust",
            false
        ]
    ],
    "Rattle": [
        [
            "effect",
            "hit",
            2
        ]
    ],
    "Reanimate": [
        [
            "effect",
            "summon",
            5
        ]
    ],
    "Reap": [
        [
            "effect",
            "hit",
            6
        ]
    ],
    "Reave": [
        [
            "effect",
            "hit",
            2
        ]
    ],
    "RefineBlade": [
        [
            "effect",
            "forge",
            4
        ]
    ],
    "Refract": [
        [
            "effect",
            "hit",
            3
        ]
    ],
    "Resonance": [
        [
            "effect",
            "strength",
            1
        ]
    ],
    "RoyalGamble": [
        [
            "keyword",
            "retain",
            true
        ]
    ],
    "Scourge": [
        [
            "effect",
            "doom",
            3
        ],
        [
            "effect",
            "draw",
            1
        ]
    ],
    "Seance": [
        [
            "cost",
            "",
            -1
        ]
    ],
    "SecondWind": [
        [
            "effect",
            "block",
            2
        ]
    ],
    "SeekingEdge": [
        [
            "effect",
            "forge",
            4
        ]
    ],
    "SetupStrike": [
        [
            "effect",
            "hit",
            2
        ],
        [
            "effect",
            "strength",
            1
        ]
    ],
    "SevenStars": [
        [
            "cost",
            "",
            -1
        ]
    ],
    "Severance": [
        [
            "effect",
            "hit",
            5
        ]
    ],
    "ShadowShield": [
        [
            "effect",
            "block",
            4
        ]
    ],
    "Shadowmeld": [
        [
            "cost",
            "",
            -1
        ]
    ],
    "ShiningStrike": [
        [
            "effect",
            "hit",
            3
        ]
    ],
    "ShrugItOff": [
        [
            "effect",
            "block",
            3
        ]
    ],
    "Skewer": [
        [
            "effect",
            "hit",
            3
        ]
    ],
    "Skim": [
        [
            "effect",
            "draw",
            1
        ]
    ],
    "Slice": [
        [
            "effect",
            "hit",
            3
        ]
    ],
    "Snakebite": [
        [
            "effect",
            "poison",
            3
        ]
    ],
    "SolarStrike": [
        [
            "effect",
            "hit",
            1
        ],
        [
            "effect",
            "stars",
            1
        ]
    ],
    "Sow": [
        [
            "effect",
            "hit",
            3
        ]
    ],
    "SpoilsOfBattle": [
        [
            "effect",
            "forge",
            3
        ]
    ],
    "Spur": [
        [
            "effect",
            "summon",
            2
        ],
        [
            "effect",
            "heal",
            2
        ]
    ],
    "Stardust": [
        [
            "effect",
            "hit",
            2
        ]
    ],
    "Stomp": [
        [
            "effect",
            "hit",
            3
        ]
    ],
    "StrikeDefect": [
        [
            "effect",
            "hit",
            3
        ]
    ],
    "StrikeIronclad": [
        [
            "effect",
            "hit",
            3
        ]
    ],
    "StrikeNecrobinder": [
        [
            "effect",
            "hit",
            3
        ]
    ],
    "StrikeRegent": [
        [
            "effect",
            "hit",
            3
        ]
    ],
    "StrikeSilent": [
        [
            "effect",
            "hit",
            3
        ]
    ],
    "SuckerPunch": [
        [
            "effect",
            "hit",
            2
        ],
        [
            "effect",
            "weak",
            1
        ]
    ],
    "Supercritical": [
        [
            "effect",
            "energy",
            2
        ]
    ],
    "Survivor": [
        [
            "effect",
            "block",
            3
        ]
    ],
    "SweepingBeam": [
        [
            "effect",
            "hit",
            3
        ]
    ],
    "Synchronize": [
        [
            "keyword",
            "exhaust",
            false
        ]
    ],
    "Synthesis": [
        [
            "effect",
            "hit",
            6
        ]
    ],
    "Taunt": [
        [
            "effect",
            "block",
            1
        ],
        [
            "effect",
            "vulnerable",
            1
        ]
    ],
    "Terraforming": [
        [
            "effect",
            "vigor",
            2
        ]
    ],
    "TeslaCoil": [
        [
            "effect",
            "hit",
            1
        ]
    ],
    "TheSmith": [
        [
            "effect",
            "forge",
            10
        ]
    ],
    "Thunderclap": [
        [
            "effect",
            "hit",
            3
        ]
    ],
    "TimesUp": [
        [
            "keyword",
            "retain",
            true
        ]
    ],
    "Tracking": [
        [
            "cost",
            "",
            -1
        ]
    ],
    "Tremble": [
        [
            "effect",
            "vulnerable",
            1
        ]
    ],
    "TrueGrit": [
        [
            "effect",
            "block",
            2
        ]
    ],
    "Turbo": [
        [
            "effect",
            "energy",
            1
        ]
    ],
    "TwinStrike": [
        [
            "effect",
            "hit",
            2
        ]
    ],
    "Undeath": [
        [
            "effect",
            "block",
            2
        ]
    ],
    "Unrelenting": [
        [
            "effect",
            "hit",
            6
        ]
    ],
    "Untouchable": [
        [
            "effect",
            "block",
            3
        ]
    ],
    "UpMySleeve": [
        [
            "effect",
            "draw",
            1
        ]
    ],
    "Venerate": [
        [
            "effect",
            "stars",
            1
        ]
    ],
    "Whirlwind": [
        [
            "effect",
            "hit",
            3
        ]
    ],
    "Wisp": [
        [
            "keyword",
            "retain",
            true
        ]
    ],
    "WroughtInWar": [
        [
            "effect",
            "hit",
            2
        ],
        [
            "effect",
            "forge",
            2
        ]
    ],
    "Zap": [
        [
            "cost",
            "",
            -1
        ]
    ]
};
for (const [id, commands] of Object.entries(ORIGINAL_UPGRADES)) {
    const base = duelEffect(id);
    if (!commands.every(([kind, key]) => kind !== "effect" || typeof base[key] === "number")) continue;
    const effect = { ...base };
    const card = GAME_CARDS[id].slice();
    const changes = [];
    for (const [kind, key, value] of commands) {
        if (kind === "cost") {
            card[1] += value;
            changes.push(`能量费用${value}`);
        } else if (kind === "keyword") {
            effect[key] = value;
            changes.push(`${value ? "获得" : "移除"}${key}`);
        } else {
            effect[key] += key === "cruelty" ? value / 100 : value;
            changes.push(`${key}+${value}`);
        }
    }
    card[0] += "+";
    card[3] += `（原版升级：${changes.join("、")}）`;
    GAME_CARDS[id + "+"] = card;
    DUEL_EFFECTS[id + "+"] = effect;
}




// BEGIN NATIVE 0.111.1 UPGRADED CARD DISPLAY
Object.assign(GAME_CARDS, {
  "Aggression+": [
    "好勇斗狠+",
    1,
    "Power",
    "固有。 在你的回合开始时，将你弃牌堆的一张随机攻击牌放入你的手牌并将其升级。",
    0
  ],
  "Anger+": [
    "愤怒+",
    0,
    "Attack",
    "造成8点伤害。 将一张此牌的复制品加入你的弃牌堆。",
    0
  ],
  "Armaments+": [
    "武装+",
    1,
    "Skill",
    "获得5点格挡。 升级你手牌中的所有牌。",
    0
  ],
  "AshenStrike+": [
    "灰烬打击+",
    1,
    "Attack",
    "造成6点伤害。 你的消耗牌堆中每有一张牌，伤害增加4。",
    0
  ],
  "Barricade+": [
    "壁垒+",
    2,
    "Power",
    "格挡不再在你的回合开始时消失。",
    0
  ],
  "Bash+": [
    "痛击+",
    2,
    "Attack",
    "造成10点伤害。 给予3层易伤。",
    0
  ],
  "BattleTrance+": [
    "战斗专注+",
    0,
    "Skill",
    "抽4张牌。 你在本回合内不能再抽任何牌。",
    0
  ],
  "BloodWall+": [
    "血墙+",
    2,
    "Skill",
    "失去2点生命。 获得20点格挡。",
    0
  ],
  "Bloodletting+": [
    "放血+",
    0,
    "Skill",
    "失去3点生命。 获得3点能量。",
    0
  ],
  "Bludgeon+": [
    "重锤+",
    3,
    "Attack",
    "造成42点伤害。",
    0
  ],
  "BodySlam+": [
    "全身撞击+",
    0,
    "Attack",
    "造成你当前格挡值的伤害。",
    0
  ],
  "Brand+": [
    "烙印+",
    0,
    "Skill",
    "失去1点生命。 消耗1张牌。 获得2点力量。",
    0
  ],
  "Break+": [
    "破击+",
    1,
    "Attack",
    "造成30点伤害。 给予7层易伤。",
    0
  ],
  "Breakthrough+": [
    "突破+",
    1,
    "Attack",
    "失去1点生命。 对所有敌人造成13点伤害。",
    0
  ],
  "Bully+": [
    "欺凌+",
    0,
    "Attack",
    "造成4点伤害。 该敌人身上每有一层易伤就额外造成3点伤害。",
    0
  ],
  "BurningPact+": [
    "燃烧契约+",
    1,
    "Skill",
    "消耗1张牌。 抽3张牌。",
    0
  ],
  "Cascade+": [
    "倾泻+",
    -1,
    "Skill",
    "打出你抽牌堆顶部的X+1张牌。",
    0
  ],
  "Cinder+": [
    "余烬+",
    2,
    "Attack",
    "造成24点伤害。 随机消耗1张牌。",
    0
  ],
  "Colossus+": [
    "巨像+",
    1,
    "Skill",
    "获得7点格挡。 在本回合中，有易伤状态的敌人对你造成的伤害降低50%。",
    0
  ],
  "Conflagration+": [
    "焚烧+",
    1,
    "Attack",
    "对所有敌人造成2点伤害5次。",
    0
  ],
  "Corruption+": [
    "腐化+",
    2,
    "Power",
    "技能牌消耗变为01点能量。 每当你打出一张技能牌时，将其消耗。",
    0
  ],
  "CrimsonMantle+": [
    "绯红披风+",
    1,
    "Power",
    "在你的回合开始时，失去1点生命并获得10点格挡。",
    0
  ],
  "Cruelty+": [
    "残酷+",
    1,
    "Power",
    "有易伤状态的敌人额外受到50%的伤害。",
    0
  ],
  "DarkEmbrace+": [
    "黑暗之拥+",
    1,
    "Power",
    "每当有一张牌被消耗时， 抽1张牌。",
    0
  ],
  "DefendIronclad+": [
    "防御+",
    1,
    "Skill",
    "获得8点格挡。",
    0
  ],
  "DemonForm+": [
    "恶魔形态+",
    3,
    "Power",
    "在你的回合开始时，获得4点力量。",
    0
  ],
  "Dismantle+": [
    "拆卸+",
    1,
    "Attack",
    "造成10点伤害。 如果该敌人有易伤状态，则攻击两次。",
    0
  ],
  "Dominate+": [
    "主宰+",
    1,
    "Skill",
    "给予2层易伤。 敌人身上每有一层易伤，就获得1点力量。 消耗。",
    0
  ],
  "DrumOfBattle+": [
    "战鼓+",
    1,
    "Skill",
    "抽2张牌。 这张牌被消耗时，获得3点能量。",
    0
  ],
  "EvilEye+": [
    "邪眼+",
    1,
    "Skill",
    "获得11点格挡。 如果你在本回合消耗过卡牌，则额外获得11点格挡。",
    0
  ],
  "ExpectAFight+": [
    "跃跃欲试+",
    3,
    "Skill",
    "获得16点格挡。 你每拥有一点力量，这张牌就额外获得8点格挡。",
    0
  ],
  "Feed+": [
    "狂宴+",
    1,
    "Attack",
    "造成12点伤害。 斩杀时，永久获得4点最大生命值。 消耗。",
    0
  ],
  "FeelNoPain+": [
    "无惧疼痛+",
    1,
    "Power",
    "每当有一张牌被消耗时，获得4点格挡。",
    0
  ],
  "FiendFire+": [
    "恶魔之焰+",
    2,
    "Attack",
    "消耗所有手牌。 每张被消耗的牌造成10点伤害。 消耗。",
    0
  ],
  "FightMe+": [
    "与我一战！+",
    2,
    "Attack",
    "造成6点伤害两次。 获得4点力量。 该敌人获得1点力量。",
    0
  ],
  "FlameBarrier+": [
    "火焰屏障+",
    2,
    "Skill",
    "获得16点格挡。 你在这个回合每受到一次攻击，都会对攻击者造成6点伤害。",
    0
  ],
  "ForgottenRitual+": [
    "被遗忘的仪式+",
    1,
    "Skill",
    "获得41点能量。 消耗。",
    0
  ],
  "Havoc+": [
    "破灭+",
    0,
    "Skill",
    "打出抽牌堆顶部的牌并将其消耗。",
    0
  ],
  "Headbutt+": [
    "头槌+",
    1,
    "Attack",
    "造成12点伤害。 将你弃牌堆中的一张牌放到抽牌堆顶部。",
    0
  ],
  "Hellraiser+": [
    "地狱狂徒+",
    1,
    "Power",
    "每当你抽到名字中有“打击”的牌时，对一名随机敌人打出这张牌。",
    0
  ],
  "Hemokinesis+": [
    "御血术+",
    1,
    "Attack",
    "失去2点生命。 造成20点伤害。",
    0
  ],
  "HowlFromBeyond+": [
    "彼岸咆哮+",
    3,
    "Attack",
    "对所有敌人造成24点伤害。 在你的回合结束时，如果这张牌在你的消耗牌堆中，则将其打出。",
    0
  ],
  "Impervious+": [
    "岿然不动+",
    2,
    "Skill",
    "获得40点格挡。 消耗。",
    0
  ],
  "InfernalBlade+": [
    "地狱之刃+",
    0,
    "Skill",
    "将一张随机攻击牌加入你的手牌。那张牌在本回合内可以免费打出。 消耗。",
    0
  ],
  "Inferno+": [
    "狱火+",
    1,
    "Power",
    "在你的回合开始时，失去1点生命。 每当你在你的回合内失去生命时，对所有敌人造成9点伤害。",
    0
  ],
  "Inflame+": [
    "燃烧+",
    1,
    "Power",
    "获得3点力量。",
    0
  ],
  "IronWave+": [
    "铁斩波+",
    1,
    "Attack",
    "获得7点格挡。 造成7点伤害。",
    0
  ],
  "Juggernaut+": [
    "势不可当+",
    2,
    "Power",
    "每当你获得格挡时，对随机敌人造成8点伤害。",
    0
  ],
  "Juggling+": [
    "杂耍+",
    1,
    "Power",
    "固有。 将你在每回合打出的第三张攻击牌的复制品加入你的手牌。",
    0
  ],
  "Mangle+": [
    "凌虐+",
    3,
    "Attack",
    "造成26点伤害。 敌人在本回合失去15点力量。",
    0
  ],
  "MoltenFist+": [
    "熔融之拳+",
    1,
    "Attack",
    "造成14点伤害。 将该敌人身上的易伤层数翻倍。 消耗。",
    0
  ],
  "NotYet+": [
    "时候未到+",
    2,
    "Skill",
    "回复13点生命。 消耗。",
    0
  ],
  "Offering+": [
    "祭品+",
    0,
    "Skill",
    "失去6点生命。 获得2点能量。 抽5张牌。 消耗。",
    0
  ],
  "OneTwoPunch+": [
    "连环拳+",
    1,
    "Skill",
    "在这个回合，你打出的下2张攻击牌会被额外打出一次。",
    0
  ],
  "PactsEnd+": [
    "契约终结+",
    0,
    "Attack",
    "如果你的消耗牌堆拥有大于等于3张牌， 则对所有敌人造成24点伤害。",
    0
  ],
  "PerfectedStrike+": [
    "完美打击+",
    2,
    "Attack",
    "造成6点伤害。 你每有一张名字中含有“打击”的牌，伤害+3。",
    0
  ],
  "Pillage+": [
    "劫掠+",
    1,
    "Attack",
    "造成9点伤害。 抽牌直到你抽到一张非攻击牌。",
    0
  ],
  "PommelStrike+": [
    "剑柄打击+",
    1,
    "Attack",
    "造成10点伤害。 抽2张牌。",
    0
  ],
  "PrimalForce+": [
    "原始力量+",
    0,
    "Skill",
    "将手牌中的所有攻击牌变化为巨石+。",
    0
  ],
  "Pyre+": [
    "薪火之源+",
    2,
    "Power",
    "在回合开始时，获得2点能量。",
    0
  ],
  "Rage+": [
    "狂怒+",
    0,
    "Skill",
    "打出此牌后，你在这个回合内每打出一张攻击牌，获得5点格挡。",
    0
  ],
  "Rampage+": [
    "暴走+",
    1,
    "Attack",
    "造成10点伤害。 将这张牌在本场战斗中的伤害增加10。",
    0
  ],
  "Rupture+": [
    "撕裂+",
    1,
    "Power",
    "每当你在你的回合失去生命值时, 获得2点力量。",
    0
  ],
  "SecondWind+": [
    "重振精神+",
    1,
    "Skill",
    "消耗手牌中所有非攻击牌，每张获得7点格挡。",
    0
  ],
  "SetupStrike+": [
    "预备打击+",
    1,
    "Attack",
    "造成9点伤害。 在本回合内获得4点力量。",
    0
  ],
  "ShrugItOff+": [
    "耸肩无视+",
    1,
    "Skill",
    "获得11点格挡。 抽1张牌。",
    0
  ],
  "Spite+": [
    "怨恨+",
    0,
    "Attack",
    "造成5点伤害。 如果你在本回合失去过生命值， 则攻击3次。",
    0
  ],
  "Stampede+": [
    "惊逃+",
    1,
    "Power",
    "在你的回合结束时，随机打出你手牌中的1张攻击牌攻击随机敌人。",
    0
  ],
  "Stoke+": [
    "添柴+",
    1,
    "Skill",
    "消耗所有手牌。 每消耗一张牌，将1张随机已升级的牌加入你的手牌。",
    0
  ],
  "Stomp+": [
    "踩踏+",
    3,
    "Attack",
    "对所有敌人造成15点伤害。 你在本回合中每打出过一张攻击牌，其耗能减少11点能量。",
    0
  ],
  "StoneArmor+": [
    "岩石铠甲+",
    1,
    "Power",
    "获得6层覆甲。",
    0
  ],
  "StrikeIronclad+": [
    "打击+",
    1,
    "Attack",
    "造成9点伤害。",
    0
  ],
  "SwordBoomerang+": [
    "飞剑回旋镖+",
    1,
    "Attack",
    "随机对敌人造成3点伤害4次。",
    0
  ],
  "Taunt+": [
    "挑衅+",
    1,
    "Skill",
    "获得7点格挡。 给予2层易伤。",
    0
  ],
  "TearAsunder+": [
    "扯碎+",
    2,
    "Attack",
    "造成7点伤害。 在本场战斗中，你每失去过一次生命值，这张牌就额外造成一次伤害。",
    0
  ],
  "Thrash+": [
    "痛殴+",
    1,
    "Attack",
    "造成6点伤害两次。 消耗你的手牌中随机一张攻击牌，并将它的伤害添加给这张牌。",
    0
  ],
  "Thunderclap+": [
    "闪电霹雳+",
    1,
    "Attack",
    "对所有敌人造成7点伤害，给予1层易伤。",
    0
  ],
  "Tremble+": [
    "战栗+",
    1,
    "Skill",
    "给予4层易伤。 消耗。",
    0
  ],
  "TrueGrit+": [
    "坚毅+",
    1,
    "Skill",
    "获得9点格挡。 消耗1张牌。",
    0
  ],
  "TwinStrike+": [
    "双重打击+",
    1,
    "Attack",
    "造成7点伤害两次。",
    0
  ],
  "Unmovable+": [
    "坚定不移+",
    1,
    "Power",
    "翻倍你每回合第一次从卡牌中获得的格挡。",
    0
  ],
  "Unrelenting+": [
    "无情猛攻+",
    2,
    "Attack",
    "造成20点伤害。 你打出的下一张攻击牌耗能变为01点能量。",
    0
  ],
  "Uppercut+": [
    "上勾拳+",
    2,
    "Attack",
    "造成13点伤害。 给予2层虚弱。 给予2层易伤。",
    0
  ],
  "Vicious+": [
    "凶恶+",
    1,
    "Power",
    "每当你给予易伤时，抽2张牌。",
    0
  ],
  "Whirlwind+": [
    "旋风斩+",
    -1,
    "Attack",
    "对所有敌人造成8点伤害X次。",
    0
  ],
  "Abrasive+": [
    "磨蚀+",
    3,
    "Power",
    "奇巧。 获得1点敏捷。 获得6点荆棘。",
    0
  ],
  "Accelerant+": [
    "触媒+",
    1,
    "Power",
    "中毒会额外触发2次。",
    0
  ],
  "Accuracy+": [
    "精准+",
    1,
    "Power",
    "小刀额外造成6点伤害。",
    0
  ],
  "Acrobatics+": [
    "杂技+",
    1,
    "Skill",
    "抽4张牌。 丢弃1张牌。",
    0
  ],
  "Adrenaline+": [
    "肾上腺素+",
    0,
    "Skill",
    "获得2点能量。 抽2张牌。 消耗。",
    0
  ],
  "Afterimage+": [
    "余像+",
    1,
    "Power",
    "固有。 你每打出一张牌，都获得1点格挡。",
    0
  ],
  "Anticipate+": [
    "预判+",
    0,
    "Skill",
    "在本回合获得4点敏捷。",
    0
  ],
  "Assassinate+": [
    "刺杀+",
    0,
    "Attack",
    "固有。 造成13点伤害。 给予2层易伤。 消耗。",
    0
  ],
  "Backflip+": [
    "后空翻+",
    1,
    "Skill",
    "获得8点格挡。 抽2张牌。",
    0
  ],
  "Backstab+": [
    "背刺+",
    0,
    "Attack",
    "固有。 造成15点伤害。 消耗。",
    0
  ],
  "BladeOfInk+": [
    "墨之刃+",
    1,
    "Skill",
    "添加3张墨影小刀到你的手牌。",
    0
  ],
  "BladeDance+": [
    "刀刃之舞+",
    1,
    "Skill",
    "添加4张小刀到你的手牌。 消耗。",
    0
  ],
  "Blur+": [
    "残影+",
    1,
    "Skill",
    "获得8点格挡。 你的下一回合开始时格挡不会消失。",
    0
  ],
  "BouncingFlask+": [
    "弹跳药瓶+",
    2,
    "Skill",
    "随机给予敌人3层中毒4次。",
    0
  ],
  "BubbleBubble+": [
    "咕嘟冒泡+",
    1,
    "Skill",
    "如果敌方拥有中毒，则给予12层中毒。",
    0
  ],
  "BulletTime+": [
    "子弹时间+",
    2,
    "Skill",
    "你在本回合内不能再抽牌。你手牌中的所有牌在本回合免费打出。",
    0
  ],
  "Burst+": [
    "爆发+",
    1,
    "Skill",
    "在这个回合，你打出的下2张技能牌会被额外打出一次。",
    0
  ],
  "CalculatedGamble+": [
    "计算下注+",
    0,
    "Skill",
    "保留。 丢弃你的所有手牌, 然后抽相同数量的牌。 消耗。",
    0
  ],
  "CloakAndDagger+": [
    "斗篷与匕首+",
    1,
    "Skill",
    "获得6点格挡。 将2张小刀添加到你的手牌。",
    0
  ],
  "CorrosiveWave+": [
    "腐蚀波+",
    1,
    "Skill",
    "打出此牌后，你在本回合每抽到一张牌，就给予所有敌人3层中毒。",
    0
  ],
  "DaggerSpray+": [
    "匕首雨+",
    1,
    "Attack",
    "对所有敌人造成6点伤害两次。",
    0
  ],
  "DaggerThrow+": [
    "投掷匕首+",
    1,
    "Attack",
    "造成12点伤害。 抽1张牌。 丢弃1张牌。",
    0
  ],
  "Dash+": [
    "冲刺+",
    2,
    "Attack",
    "获得13点格挡。 造成13点伤害。",
    0
  ],
  "DeadlyPoison+": [
    "致命毒药+",
    1,
    "Skill",
    "给予7层中毒。",
    0
  ],
  "DefendSilent+": [
    "防御+",
    1,
    "Skill",
    "获得8点格挡。",
    0
  ],
  "Deflect+": [
    "偏折+",
    0,
    "Skill",
    "获得7点格挡。",
    0
  ],
  "DodgeAndRoll+": [
    "闪躲翻滚+",
    1,
    "Skill",
    "获得6点格挡。 在下个回合，获得6点格挡。",
    0
  ],
  "EchoingSlash+": [
    "回响斩击+",
    1,
    "Attack",
    "对所有敌人造成13点伤害。 每有一名敌人被击杀，就重复此效果。",
    0
  ],
  "Envenom+": [
    "涂毒+",
    2,
    "Power",
    "每有一次攻击造成未被格挡的伤害，就给予2层中毒。",
    0
  ],
  "EscapePlan+": [
    "逃脱计划+",
    0,
    "Skill",
    "抽1张牌。 如果抽到的是技能牌，则获得5点格挡。",
    0
  ],
  "Expertise+": [
    "独门技术+",
    1,
    "Skill",
    "抽3张牌。 这些牌在本回合获得保留。",
    0
  ],
  "Expose+": [
    "暴露+",
    0,
    "Skill",
    "去除敌人身上的所有格挡值和人工制品。 并给予3层易伤。 消耗。",
    0
  ],
  "FanOfKnives+": [
    "刀扇+",
    2,
    "Power",
    "小刀现在会攻击所有敌人。 将5张小刀添加到你的手牌。",
    0
  ],
  "Finisher+": [
    "终结技+",
    1,
    "Attack",
    "在这个回合内每打出过一张攻击牌，就造成8点伤害一次。",
    0
  ],
  "Flechettes+": [
    "飞镖+",
    1,
    "Attack",
    "手牌中每有一张技能牌，造成7点伤害。",
    0
  ],
  "FlickFlack+": [
    "翻越撑击+",
    1,
    "Attack",
    "奇巧。 对所有敌人造成9点伤害。",
    0
  ],
  "Sidestep+": [
    "侧步+",
    0,
    "Skill",
    "下回合，获得2点能量。",
    0
  ],
  "Footwork+": [
    "灵动步法+",
    1,
    "Power",
    "获得3点敏捷。",
    0
  ],
  "GrandFinale+": [
    "华丽收场+",
    0,
    "Attack",
    "只有当你的抽牌堆中没有牌时才能打出。对所有敌人造成75点伤害。",
    0
  ],
  "HandTrick+": [
    "手上技法+",
    1,
    "Skill",
    "获得10点格挡。 在本回合给你手牌中的一张技能牌添加奇巧。",
    0
  ],
  "Haze+": [
    "迷雾+",
    2,
    "Skill",
    "给予所有敌人6层中毒和2层虚弱。",
    0
  ],
  "HiddenDaggers+": [
    "隐秘匕首+",
    0,
    "Skill",
    "丢弃2张牌。 将2张小刀+加入你的手牌。",
    0
  ],
  "InfiniteBlades+": [
    "无尽刀刃+",
    1,
    "Power",
    "固有。 在你的回合开始时，在你的手牌中加入1张小刀。",
    0
  ],
  "KnifeTrap+": [
    "刀刃陷阱+",
    2,
    "Skill",
    "将你消耗牌堆中的所有小刀升级然后对一名敌人打出。",
    0
  ],
  "LeadingStrike+": [
    "先制打击+",
    1,
    "Attack",
    "造成6点伤害。 将2张小刀加入你的手牌。",
    0
  ],
  "LegSweep+": [
    "扫腿+",
    2,
    "Skill",
    "给予3层虚弱。 获得14点格挡。",
    0
  ],
  "Malaise+": [
    "萎靡+",
    -1,
    "Skill",
    "敌人失去X+1点力量。给予X+1层虚弱。 消耗。",
    0
  ],
  "MasterPlanner+": [
    "谋划专家+",
    1,
    "Power",
    "当你打出技能牌时，该牌获得奇巧。",
    0
  ],
  "MementoMori+": [
    "铭记死亡+",
    1,
    "Attack",
    "造成11点伤害。 本回合每丢弃过一张牌，则增加5点额外伤害。",
    0
  ],
  "Mirage+": [
    "蜃景+",
    1,
    "Skill",
    "获得等量于所有敌人中毒层数总和的格挡。",
    0
  ],
  "Murder+": [
    "谋杀+",
    2,
    "Attack",
    "造成1点伤害。 你在本场战斗中每抽过一张牌，此牌就额外造成1点伤害。",
    0
  ],
  "Neutralize+": [
    "中和+",
    0,
    "Attack",
    "造成4点伤害。 给予2层虚弱。",
    0
  ],
  "Nightmare+": [
    "夜魇+",
    2,
    "Skill",
    "选择一张牌。 在下个回合将这张牌的3张复制品加入你的手牌。 消耗。",
    0
  ],
  "NoxiousFumes+": [
    "毒雾+",
    1,
    "Power",
    "在你的回合开始时，给予所有敌人3层中毒。",
    0
  ],
  "Outbreak+": [
    "毒性爆发+",
    3,
    "Skill",
    "给予所有敌人12层中毒。 立即触发中毒。",
    0
  ],
  "PhantomBlades+": [
    "幻影之刃+",
    1,
    "Power",
    "小刀获得保留。 你在每回合打出的第一张小刀额外造成12点伤害。",
    0
  ],
  "PiercingWail+": [
    "尖啸+",
    1,
    "Skill",
    "所有敌人在本回合失去8点力量。 消耗。",
    0
  ],
  "Pinpoint+": [
    "精密瞄准+",
    3,
    "Attack",
    "造成19点伤害。 你在本回合中每打出过一张技能牌，其耗能减少11点能量。",
    0
  ],
  "PoisonedStab+": [
    "带毒刺击+",
    1,
    "Attack",
    "造成8点伤害。 给予4层中毒。",
    0
  ],
  "Pounce+": [
    "猛扑+",
    2,
    "Attack",
    "造成20点伤害。 你的下一张技能牌耗能变为01点能量。",
    0
  ],
  "PreciseCut+": [
    "精确切击+",
    0,
    "Attack",
    "造成16点伤害。 你的手牌中每有一张牌，此牌的伤害就降低2点。",
    0
  ],
  "Predator+": [
    "猎杀者+",
    2,
    "Attack",
    "造成20点伤害。 在下个回合抽2张牌。",
    0
  ],
  "Prepared+": [
    "早有准备+",
    0,
    "Skill",
    "抽2张牌。 丢弃2张牌。",
    0
  ],
  "Reflex+": [
    "本能反应+",
    3,
    "Skill",
    "奇巧。 抽3张牌。",
    0
  ],
  "Ricochet+": [
    "连续反弹+",
    2,
    "Attack",
    "奇巧。 随机对敌人造成3点伤害5次。",
    0
  ],
  "SerpentForm+": [
    "群蛇形态+",
    3,
    "Power",
    "你每打出一张牌，就对随机一名敌人造成6点伤害。",
    0
  ],
  "ShadowStep+": [
    "暗影步+",
    0,
    "Skill",
    "丢弃所有手牌。 在下个回合，你所有的攻击伤害翻倍。",
    0
  ],
  "Shadowmeld+": [
    "融入暗影+",
    0,
    "Skill",
    "本回合你获得的格挡值翻倍。",
    0
  ],
  "Skewer+": [
    "串刺+",
    -1,
    "Attack",
    "造成11点伤害X次。",
    0
  ],
  "Slice+": [
    "切割+",
    0,
    "Attack",
    "造成9点伤害。",
    0
  ],
  "Snakebite+": [
    "蛇咬+",
    2,
    "Skill",
    "保留。 给予10层中毒。",
    0
  ],
  "Speedster+": [
    "速行者+",
    2,
    "Power",
    "固有。 每当你在回合进行中抽到一张牌时，对所有敌人造成2点伤害。",
    0
  ],
  "StormOfSteel+": [
    "钢铁风暴+",
    1,
    "Skill",
    "丢弃所有手牌。 每丢弃一张牌，就将一张小刀+添加至你的手牌。",
    0
  ],
  "Strangle+": [
    "紧勒+",
    1,
    "Attack",
    "造成10点伤害。 你在这个回合内每出一张牌，该名敌人都会失去3点生命。",
    0
  ],
  "StrikeSilent+": [
    "打击+",
    1,
    "Attack",
    "造成9点伤害。",
    0
  ],
  "SuckerPunch+": [
    "突然一拳+",
    1,
    "Attack",
    "造成10点伤害。 给予2层虚弱。",
    0
  ],
  "Suppress+": [
    "压制+",
    0,
    "Attack",
    "固有。 造成17点伤害。 给予5层虚弱。",
    0
  ],
  "Survivor+": [
    "生存者+",
    1,
    "Skill",
    "获得11点格挡。 丢弃1张牌。",
    0
  ],
  "Tactician+": [
    "战术大师+",
    3,
    "Skill",
    "奇巧。 获得2点能量。",
    0
  ],
  "TheHunt+": [
    "狩猎+",
    1,
    "Attack",
    "造成15点伤害。 斩杀时，额外获得一次卡牌奖励。 消耗。",
    0
  ],
  "ToolsOfTheTrade+": [
    "必备工具+",
    0,
    "Power",
    "在你的回合开始时，抽1张牌，丢弃1张牌。",
    0
  ],
  "Tracking+": [
    "跟踪+",
    1,
    "Power",
    "处于虚弱状态的敌人受到的攻击伤害增加50%。",
    0
  ],
  "Untouchable+": [
    "触不可及+",
    2,
    "Skill",
    "奇巧。 获得9点格挡。",
    0
  ],
  "UpMySleeve+": [
    "袖里乾坤+",
    2,
    "Skill",
    "将4张小刀加入你的手牌。 这张牌的耗能减少1。",
    0
  ],
  "WellLaidPlans+": [
    "计划妥当+",
    1,
    "Power",
    "在你的回合结束时，你不再丢弃你的手牌。",
    0
  ],
  "WraithForm+": [
    "幽魂形态+",
    3,
    "Power",
    "获得3无实体。 在你的回合开始时，失去1点敏捷。",
    0
  ],
  "Alignment+": [
    "星位序列+",
    0,
    "Skill",
    "获得3点能量。",
    2
  ],
  "Arsenal+": [
    "武器库+",
    1,
    "Power",
    "固有。 每当你生成一张牌，就获得1点力量。",
    0
  ],
  "AstralPulse+": [
    "星界脉冲+",
    0,
    "Attack",
    "对所有敌人造成8点伤害两次。",
    3
  ],
  "BeatIntoShape+": [
    "锻打成型+",
    1,
    "Attack",
    "造成7点伤害。 铸造7。 本回合内，你此前每击中过该敌人一次，这张牌就额外铸造7点。",
    0
  ],
  "Begone+": [
    "下去！+",
    1,
    "Skill",
    "选择你手牌中的一张牌，将其变化为仆从打击+。",
    0
  ],
  "BigBang+": [
    "大爆炸+",
    0,
    "Skill",
    "固有。 抽1张牌。 获得1点能量。 获得1点星星。 铸造5。 消耗。",
    0
  ],
  "BlackHole+": [
    "黑洞+",
    1,
    "Power",
    "每当你花费或获得1点星星时，对所有敌人造成4点伤害。",
    0
  ],
  "Bombardment+": [
    "轰击+",
    3,
    "Attack",
    "造成24点伤害。 你的回合开始时，如果这张牌在你的消耗牌堆中，则将其打出。 消耗。",
    0
  ],
  "Bulwark+": [
    "铸墙+",
    2,
    "Skill",
    "获得15点格挡。 铸造13。",
    0
  ],
  "BundleOfJoy+": [
    "新生之喜+",
    1,
    "Skill",
    "将4张随机无色牌添加到你的手牌。 消耗。",
    0
  ],
  "CelestialMight+": [
    "天穹之力+",
    2,
    "Attack",
    "造成6点伤害4次。",
    0
  ],
  "Charge+": [
    "冲锋！！+",
    1,
    "Skill",
    "选择你抽牌堆中的2张牌，将其变化为 仆从俯冲+。",
    0
  ],
  "ChildOfTheStars+": [
    "群星之子+",
    1,
    "Power",
    "每当你花费1点星星时，每花费一点1点星星，获得3点格挡。",
    0
  ],
  "CloakOfStars+": [
    "群星斗篷+",
    0,
    "Skill",
    "获得10点格挡。",
    1
  ],
  "CollisionCourse+": [
    "碰撞轨迹+",
    0,
    "Attack",
    "造成14点伤害。 将一张碎屑添加至你的手牌。",
    0
  ],
  "Comet+": [
    "彗星+",
    0,
    "Attack",
    "造成44点伤害。 给予3层虚弱。 给予3层易伤。",
    5
  ],
  "Conqueror+": [
    "征服者+",
    1,
    "Skill",
    "铸造5。 君王之剑在本回合对敌人造成双倍伤害。",
    0
  ],
  "Convergence+": [
    "汇流+",
    1,
    "Skill",
    "在本回合保留你的手牌。 在下个回合， 获得1点能量与2点星星。",
    0
  ],
  "CosmicIndifference+": [
    "宇宙冷漠+",
    1,
    "Skill",
    "获得9点格挡。 将弃牌堆中的一张牌放到你的抽牌堆的顶部。",
    0
  ],
  "CrashLanding+": [
    "迫降+",
    1,
    "Attack",
    "对所有敌人造成26点伤害。 用碎屑填满你的手牌。",
    0
  ],
  "CrescentSpear+": [
    "新月长矛+",
    1,
    "Attack",
    "造成8点伤害。 你每有一张拥有1点星星耗能的卡牌，这张牌就额外造成3点伤害。",
    1
  ],
  "CrushUnder+": [
    "下砸+",
    1,
    "Attack",
    "对所有敌人造成9点伤害。所有敌人在本回合失去2点力量。",
    0
  ],
  "DecisionsDecisions+": [
    "抉择，抉择+",
    0,
    "Skill",
    "抽5张牌。 选择你手牌中的一张技能牌，并将其打出3次。 消耗。",
    6
  ],
  "DefendRegent+": [
    "防御+",
    1,
    "Skill",
    "获得8点格挡。",
    0
  ],
  "Devastate+": [
    "葬送+",
    1,
    "Attack",
    "造成45点伤害。",
    4
  ],
  "DyingStar+": [
    "星灭+",
    1,
    "Attack",
    "虚无。 对所有敌人造成11点伤害。所有敌人在本回合中失去11点力量。",
    3
  ],
  "FallingStar+": [
    "陨星+",
    0,
    "Attack",
    "造成12点伤害。 给予1层虚弱。 给予1层易伤。",
    2
  ],
  "ForegoneConclusion+": [
    "既定事项+",
    1,
    "Skill",
    "在下个回合，从你的抽牌堆中选择3张牌放入你的手牌。",
    0
  ],
  "Furnace+": [
    "熔炉+",
    1,
    "Power",
    "在你的回合开始时，铸造7。",
    0
  ],
  "GammaBlast+": [
    "伽马爆破+",
    0,
    "Attack",
    "造成18点伤害。 给予2层虚弱。 给予2层易伤。",
    3
  ],
  "GatherLight+": [
    "收集光辉+",
    1,
    "Skill",
    "获得11点格挡。 获得1点星星。",
    0
  ],
  "Genesis+": [
    "创世纪+",
    2,
    "Power",
    "在你的回合开始时，获得3点星星。",
    0
  ],
  "Glimmer+": [
    "微光+",
    1,
    "Skill",
    "抽4张牌。 将你手牌中的1张牌放到抽牌堆顶部。",
    0
  ],
  "Glitterstream+": [
    "流光溢彩+",
    2,
    "Skill",
    "获得13点格挡。 在下一回合获得7点格挡。",
    0
  ],
  "Glow+": [
    "辉光+",
    1,
    "Skill",
    "获得2点星星。 抽1张牌。 下一回合抽1张牌。",
    0
  ],
  "Guards+": [
    "护驾！！！+",
    2,
    "Skill",
    "将你手牌中的任意张牌变化为仆从捐躯+。 消耗。",
    0
  ],
  "GuidingStar+": [
    "引导之星+",
    1,
    "Attack",
    "造成13点伤害。 在下个回合抽3张牌。",
    1
  ],
  "HeavenlyDrill+": [
    "天际钻头+",
    -1,
    "Attack",
    "造成10点伤害X次。 如果X的最终数值为4或以上，则将X的数值翻倍。",
    0
  ],
  "Hegemony+": [
    "霸权+",
    2,
    "Attack",
    "造成18点伤害。 在下个回合获得3点能量。",
    0
  ],
  "HeirloomHammer+": [
    "传承之锤+",
    2,
    "Attack",
    "造成25点伤害。 选择你手牌中的一张无色牌。将这张牌的一张复制品放入你的手牌。",
    0
  ],
  "HiddenCache+": [
    "隐秘藏品+",
    1,
    "Skill",
    "获得1点星星。 在下个回合获得4点星星。",
    0
  ],
  "IAmInvincible+": [
    "所向无敌+",
    1,
    "Skill",
    "获得13点格挡。 在你的回合结束时，如果这张牌位于抽牌堆顶部，则将其打出。",
    0
  ],
  "KinglyKick+": [
    "王者之踢+",
    4,
    "Attack",
    "造成35点伤害。 每当你抽到这张牌时，这张牌的耗能减少1。",
    0
  ],
  "KinglyPunch+": [
    "王者之拳+",
    1,
    "Attack",
    "造成10点伤害。 每当你抽到这张牌时，在这场战斗中其伤害增加6。",
    0
  ],
  "KnockoutBlow+": [
    "决胜一击+",
    3,
    "Attack",
    "造成38点伤害。 如果此牌击杀了敌人，获得5点星星。",
    0
  ],
  "KnowThyPlace+": [
    "何人僭越+",
    0,
    "Skill",
    "给予1层虚弱。 给予1层易伤。",
    0
  ],
  "LunarBlast+": [
    "月面射击+",
    0,
    "Attack",
    "本回合中每打出过一张技能牌，此牌额外造成5点伤害一次。",
    0
  ],
  "MakeItSo+": [
    "如此甚好+",
    0,
    "Attack",
    "造成9点伤害。 你每在一回合内打出3张技能牌，就将这张牌放入你的手牌。",
    0
  ],
  "ManifestAuthority+": [
    "君权自授+",
    1,
    "Skill",
    "获得8点格挡。 将一张随机升级过的无色牌加入你的手牌。",
    0
  ],
  "MeteorShower+": [
    "流星雨+",
    0,
    "Attack",
    "对所有敌人造成21点伤害。 给予所有敌人2层虚弱和易伤。",
    2
  ],
  "MonarchsGaze+": [
    "王之凝视+",
    1,
    "Power",
    "每当你攻击敌人的时候，这名敌人在本回合失去1点力量。",
    0
  ],
  "Monologue+": [
    "独白+",
    0,
    "Skill",
    "保留。 每当你在本回合打出卡牌时，在本回合获得1点力量。",
    0
  ],
  "NeutronAegis+": [
    "中子护盾+",
    1,
    "Power",
    "获得11层覆甲。",
    5
  ],
  "Orbit+": [
    "环绕轨道+",
    1,
    "Power",
    "你每花费41点能量， 就获得1点能量。",
    0
  ],
  "PaleBlueDot+": [
    "暗淡蓝点+",
    1,
    "Power",
    "如果你在一回合内打出了大于等于5张牌，在下个回合开始时抽2张牌。",
    0
  ],
  "Parry+": [
    "招架+",
    1,
    "Power",
    "君王之剑现在能让你获得14点格挡。",
    0
  ],
  "ParticleWall+": [
    "粒子墙+",
    0,
    "Skill",
    "获得12点格挡。 将此牌返回你的手牌。",
    2
  ],
  "Patter+": [
    "星星点点+",
    1,
    "Skill",
    "获得10点格挡。 获得3点活力。",
    0
  ],
  "PhotonCut+": [
    "光子切割+",
    1,
    "Attack",
    "造成13点伤害。 抽2张牌。 将手牌中的一张牌放到抽牌堆顶部。",
    0
  ],
  "PillarOfCreation+": [
    "创世之柱+",
    1,
    "Power",
    "你每次生成卡牌时，获得3点格挡。",
    0
  ],
  "Prophesize+": [
    "预言+",
    2,
    "Skill",
    "抽9张牌。",
    0
  ],
  "Quasar+": [
    "类星体+",
    0,
    "Skill",
    "从3张随机升级过的无色牌中选择1张加入你的手牌。",
    2
  ],
  "Radiate+": [
    "辐射+",
    0,
    "Attack",
    "你在本回合每获得一点1点星星，此牌就对所有敌人造成4点伤害一次。",
    0
  ],
  "RefineBlade+": [
    "淬炼刀刃+",
    1,
    "Skill",
    "铸造12。 在下个回合获得1点能量。",
    0
  ],
  "Reflect+": [
    "倒映+",
    1,
    "Skill",
    "获得20点格挡。 在本回合将你格挡掉的攻击伤害反弹给攻击者。",
    3
  ],
  "Resonance+": [
    "共鸣+",
    1,
    "Skill",
    "获得2点力量。所有敌人失去1点力量。",
    2
  ],
  "RoyalGamble+": [
    "胜券在王+",
    0,
    "Skill",
    "保留。 获得91点星星。 消耗。",
    5
  ],
  "Royalties+": [
    "王国资产+",
    1,
    "Power",
    "在战斗结束时，获得40金币。",
    0
  ],
  "SeekingEdge+": [
    "追踪之刃+",
    1,
    "Power",
    "铸造11。 君王之剑现在会对所有敌人造成伤害。",
    0
  ],
  "SevenStars+": [
    "七星+",
    1,
    "Attack",
    "对所有敌人造成7点伤害7次。",
    7
  ],
  "ShiningStrike+": [
    "明耀打击+",
    1,
    "Attack",
    "造成11点伤害。 获得2点星星。 将这张牌放置于你的抽牌堆顶部。",
    0
  ],
  "SolarStrike+": [
    "太阳打击+",
    1,
    "Attack",
    "造成10点伤害。 获得2点星星。",
    0
  ],
  "SpectrumShift+": [
    "光谱偏移+",
    1,
    "Power",
    "在你的回合开始时，将1张随机无色牌添加到你的手牌中。",
    0
  ],
  "SpoilsOfBattle+": [
    "战利品+",
    1,
    "Skill",
    "铸造9。 抽2张牌。",
    0
  ],
  "Stardust+": [
    "星尘+",
    0,
    "Attack",
    "随机对敌人造成7点伤害X次。",
    -1
  ],
  "StrikeRegent+": [
    "打击+",
    1,
    "Attack",
    "造成9点伤害。",
    0
  ],
  "SummonForth+": [
    "征召上前+",
    1,
    "Skill",
    "不论何处，将君王之剑放入你的手牌。 铸造11。",
    0
  ],
  "Supermassive+": [
    "超质量体+",
    1,
    "Attack",
    "造成5点伤害。 你在本场战斗中每生成过一张牌，这张牌就额外造成4点伤害。",
    0
  ],
  "SwordSage+": [
    "剑圣+",
    1,
    "Power",
    "君王之剑获得重放1。",
    0
  ],
  "Terraforming+": [
    "地形改造+",
    1,
    "Skill",
    "获得10点活力。",
    0
  ],
  "TheSealedThrone+": [
    "封印王座+",
    0,
    "Power",
    "你每打出一张牌，获得1点星星。",
    3
  ],
  "TheSmith+": [
    "铸剑者+",
    1,
    "Skill",
    "铸造40。",
    4
  ],
  "Tyranny+": [
    "暴政+",
    1,
    "Power",
    "固有。 在你的回合开始时，抽一张牌，并从你的手牌中消耗1张牌。",
    0
  ],
  "Venerate+": [
    "崇拜+",
    1,
    "Skill",
    "获得3点星星。",
    0
  ],
  "VoidForm+": [
    "虚空形态+",
    3,
    "Power",
    "结束你的回合。 你可以免费打出每回合的前2张牌。",
    0
  ],
  "WroughtInWar+": [
    "战火铸就+",
    1,
    "Attack",
    "造成9点伤害。 铸造9。",
    0
  ],
  "Afterlife+": [
    "来生+",
    1,
    "Skill",
    "召唤9。 消耗。",
    0
  ],
  "BansheesCry+": [
    "女妖之嚎+",
    7,
    "Attack",
    "对所有敌人造成33点伤害。 本场战斗中每打出过一张虚无牌，此牌的耗能就减少2点能量。",
    0
  ],
  "BlightStrike+": [
    "荒疫打击+",
    1,
    "Attack",
    "造成10点伤害。 给予等量于所造成伤害的灾厄。",
    0
  ],
  "Bodyguard+": [
    "护卫+",
    1,
    "Skill",
    "召唤7。",
    0
  ],
  "BoneShards+": [
    "碎骨+",
    1,
    "Attack",
    "如果奥斯提存活，则他对所有敌人造成12点伤害并且你获得12点格挡。 然后奥斯提死去。",
    0
  ],
  "BorrowedTime+": [
    "预借时间+",
    1,
    "Skill",
    "获得61点能量。 所有卡牌在本回合耗能增加1点能量。",
    0
  ],
  "Bury+": [
    "埋葬+",
    4,
    "Attack",
    "造成63点伤害。",
    0
  ],
  "Calcify+": [
    "钙化+",
    1,
    "Power",
    "奥斯提的攻击额外造成6点伤害。",
    0
  ],
  "CallOfTheVoid+": [
    "虚空之唤+",
    1,
    "Power",
    "固有。 在你的回合开始时，将1张随机牌添加到你的手牌中。添加的牌会获得虚无。",
    0
  ],
  "CaptureSpirit+": [
    "捕捉灵魂+",
    1,
    "Skill",
    "敌人失去4点生命。 将4张灵魂加入你的抽牌堆。",
    0
  ],
  "Cleanse+": [
    "洁净+",
    1,
    "Skill",
    "召唤5。 从你的抽牌堆中选择一张牌将其消耗。",
    0
  ],
  "Countdown+": [
    "倒数计时+",
    1,
    "Power",
    "在你的回合开始时，给予随机敌人9层灾厄。",
    0
  ],
  "DanseMacabre+": [
    "死亡之舞+",
    1,
    "Power",
    "每当你打出一张耗能大于等于2点能量的牌时，获得6点格挡。",
    0
  ],
  "DeathMarch+": [
    "死亡行军+",
    1,
    "Attack",
    "造成9点伤害。 你在回合进行中每抽到一张牌，都会使其额外造成6点伤害。",
    0
  ],
  "Deathbringer+": [
    "死亡使者+",
    2,
    "Skill",
    "给予所有敌人26层灾厄和1层虚弱。",
    0
  ],
  "DeathsDoor+": [
    "死亡之门+",
    1,
    "Skill",
    "获得7点格挡。 如果你在本回合中曾给予过灾厄，则额外获得2次格挡。",
    0
  ],
  "Debilitate+": [
    "摧残+",
    1,
    "Attack",
    "造成12点伤害。 在接下来的3回合内，该敌人身上的易伤与虚弱效果翻倍。",
    0
  ],
  "DefendNecrobinder+": [
    "防御+",
    1,
    "Skill",
    "获得8点格挡。",
    0
  ],
  "Defile+": [
    "玷污+",
    1,
    "Attack",
    "虚无。 造成17点伤害。",
    0
  ],
  "Defy+": [
    "违逆+",
    1,
    "Skill",
    "虚无。 获得9点格挡。 给予1层虚弱。",
    0
  ],
  "Delay+": [
    "拖延+",
    2,
    "Skill",
    "获得13点格挡。 在下个回合， 获得2点能量。",
    0
  ],
  "Demesne+": [
    "领域+",
    2,
    "Power",
    "虚无。 在你的回合开始时，获得1点能量并额外多抽1张牌。",
    0
  ],
  "DevourLife+": [
    "吞噬生命+",
    1,
    "Power",
    "每当你打出一张灵魂时，召唤2。",
    0
  ],
  "Dirge+": [
    "挽歌+",
    -1,
    "Skill",
    "召唤4X次。 将X张灵魂+添加到你的抽牌堆中。 消耗。",
    0
  ],
  "DrainPower+": [
    "能量汲取+",
    1,
    "Attack",
    "造成12点伤害。 随机升级你弃牌堆中的3张牌。",
    0
  ],
  "Dredge+": [
    "清淤+",
    1,
    "Skill",
    "保留。 将3张牌从弃牌堆加入你的手牌。 消耗。",
    0
  ],
  "Eidolon+": [
    "幻景+",
    1,
    "Skill",
    "打出你消耗牌堆中的所有虚无牌。 消耗。",
    0
  ],
  "EndOfDays+": [
    "末日降临+",
    3,
    "Skill",
    "给予所有敌人37层灾厄。 杀死所有灾厄大于等于当前生命值的敌人。",
    0
  ],
  "EnfeeblingTouch+": [
    "弱化之触+",
    1,
    "Skill",
    "虚无。 让一名敌人在本回合内失去11点力量。",
    0
  ],
  "Eradicate+": [
    "根除+",
    -1,
    "Attack",
    "保留。 造成14点伤害X次。",
    0
  ],
  "Fear+": [
    "恐惧+",
    1,
    "Attack",
    "虚无。 造成8点伤害。 给予2层易伤。",
    0
  ],
  "Fetch+": [
    "取回+",
    0,
    "Attack",
    "奥斯提造成6点伤害。 如果这是这张牌第一次在本回合被打出，则抽1张牌。",
    0
  ],
  "Flatten+": [
    "重压+",
    2,
    "Attack",
    "奥斯提造成16点伤害。 如果奥斯提本回合攻击过，则这张牌的耗能变为01点能量。",
    0
  ],
  "ForbiddenGrimoire+": [
    "禁忌魔典+",
    1,
    "Power",
    "在战斗结束时，你可以从你的牌组中选一张牌移除。 永恒。",
    0
  ],
  "Friendship+": [
    "友谊+",
    1,
    "Power",
    "失去1点力量。 在每个回合开始时获得1点能量。",
    0
  ],
  "GraveWarden+": [
    "守墓人+",
    1,
    "Skill",
    "获得11点格挡。 将一张灵魂放入你的抽牌堆中。",
    0
  ],
  "Graveblast+": [
    "坟冢爆射+",
    1,
    "Attack",
    "造成6点伤害。 将弃牌堆中的一张牌放入你的手牌。",
    0
  ],
  "Hang+": [
    "吊杀+",
    1,
    "Attack",
    "造成13点伤害。 让所有“吊杀”牌对这名敌人造成的伤害翻倍。",
    0
  ],
  "Haunt+": [
    "纠缠+",
    1,
    "Power",
    "每当你打出一张灵魂时，随机一名敌人失去9点生命。",
    0
  ],
  "HighFive+": [
    "击掌+",
    2,
    "Attack",
    "奥斯提对所有敌人 造成13点伤害并给予它们 3层易伤。",
    0
  ],
  "Invoke+": [
    "唤起+",
    1,
    "Skill",
    "在下个回合召唤3并获得3点能量。",
    0
  ],
  "Lethality+": [
    "致死性+",
    1,
    "Power",
    "虚无。 每回合的第一张攻击牌会造成75%额外伤害。",
    0
  ],
  "Melancholy+": [
    "忧郁+",
    3,
    "Skill",
    "获得17点格挡。 每当有任何生物死亡时，这张牌的耗能减少1点能量。",
    0
  ],
  "Misery+": [
    "苦难+",
    0,
    "Attack",
    "保留。 造成9点伤害。 给予其他敌人该名敌人身上的所有负面效果。",
    0
  ],
  "NecroMastery+": [
    "亡灵精通+",
    2,
    "Power",
    "召唤8。 每当奥斯提失去生命值时， 所有敌人失去等量生命值。",
    0
  ],
  "NegativePulse+": [
    "负能量脉冲+",
    1,
    "Skill",
    "获得6点格挡。 给予所有敌人11层灾厄。",
    0
  ],
  "Neurosurge+": [
    "精神过载+",
    0,
    "Power",
    "获得41点能量。 抽2张牌。 在你的回合开始时，给予自身3层灾厄。",
    0
  ],
  "NoEscape+": [
    "无处可逃+",
    1,
    "Skill",
    "给予15层灾厄，敌人身上每有10层灾厄，则额外给予这名敌人5层灾厄。",
    0
  ],
  "Oblivion+": [
    "湮灭+",
    0,
    "Skill",
    "打出此牌后，你在本回合内每打出一张牌，就给予该敌人4层灾厄。",
    0
  ],
  "Pagestorm+": [
    "书页风暴+",
    0,
    "Power",
    "每当你抽到一张虚无牌时, 抽1张牌。",
    0
  ],
  "Parse+": [
    "领会+",
    1,
    "Skill",
    "虚无。 抽4张牌。",
    0
  ],
  "Poke+": [
    "戳击+",
    0,
    "Attack",
    "奥斯提造成9点伤害。",
    0
  ],
  "Protector+": [
    "守护者+",
    0,
    "Attack",
    "奥斯提造成15点伤害。 额外造成等量于奥斯提最大生命值的伤害。",
    0
  ],
  "PullAggro+": [
    "吸引仇恨+",
    2,
    "Skill",
    "召唤5。 获得9点格挡。",
    0
  ],
  "PullFromBelow+": [
    "亡魂牵引+",
    1,
    "Attack",
    "本场战斗中每打出过一张虚无牌，此牌就造成7点伤害一次。",
    0
  ],
  "Putrefy+": [
    "腐败+",
    1,
    "Skill",
    "给予3层虚弱。 给予3层易伤。 消耗。",
    0
  ],
  "Rattle+": [
    "猛晃+",
    1,
    "Attack",
    "奥斯提造成9点伤害。 本回合每使用过一次奥斯提攻击牌，此牌就额外造成一次伤害。",
    0
  ],
  "Reanimate+": [
    "死者苏生+",
    3,
    "Skill",
    "召唤25。 消耗。",
    0
  ],
  "Reap+": [
    "收割+",
    3,
    "Attack",
    "保留。 造成33点伤害。",
    0
  ],
  "ReaperForm+": [
    "死神形态+",
    3,
    "Power",
    "保留。 每当你的攻击造成伤害时，同时给予等量的灾厄。",
    0
  ],
  "Reave+": [
    "剥夺+",
    1,
    "Attack",
    "造成13点伤害。 将一张灵魂+加入你的抽牌堆。",
    0
  ],
  "RightHandHand+": [
    "得力助手+",
    0,
    "Attack",
    "奥斯提造成6点伤害。 每当你打出耗能为2点能量或以上的牌，将此牌从弃牌堆放回你的手牌。",
    0
  ],
  "Sacrifice+": [
    "牺牲+",
    0,
    "Skill",
    "保留。 如果奥斯提存活，则他死去，然后你获得等量于其最大生命值三倍的格挡。",
    0
  ],
  "Scourge+": [
    "鞭打+",
    1,
    "Skill",
    "给予16层灾厄。 抽2张牌。",
    0
  ],
  "SculptingStrike+": [
    "雕琢打击+",
    1,
    "Attack",
    "造成12点伤害。 为一张手牌添加虚无。",
    0
  ],
  "Seance+": [
    "降灵+",
    0,
    "Skill",
    "虚无。 将你抽牌堆中的一张牌变化为灵魂。",
    0
  ],
  "SentryMode+": [
    "哨卫模式+",
    1,
    "Power",
    "在你的回合开始时，将1张扫荡凝视加入你的手牌。",
    0
  ],
  "Severance+": [
    "切断+",
    2,
    "Attack",
    "造成18点伤害。 将一张灵魂分别加入你的抽牌堆，手牌和弃牌堆中。",
    0
  ],
  "SharedFate+": [
    "命运同担+",
    0,
    "Skill",
    "失去2点力量。 敌人失去3点力量。 消耗。",
    0
  ],
  "Shroud+": [
    "厄运之衣+",
    1,
    "Power",
    "每当你给予灾厄时，获得4点格挡。",
    0
  ],
  "SicEm+": [
    "紧追不放+",
    1,
    "Attack",
    "奥斯提造成6点伤害。 在本回合内，每当奥斯提攻击这名敌人时，召唤4。",
    0
  ],
  "SleightOfFlesh+": [
    "血肉戏法+",
    2,
    "Power",
    "每当你给予一个敌人负面状态时，使其受到13点伤害。",
    0
  ],
  "Snap+": [
    "响指+",
    1,
    "Attack",
    "奥斯提造成10点伤害。 给手牌中的一张牌添加保留。",
    0
  ],
  "SoulStorm+": [
    "灵魂风暴+",
    1,
    "Attack",
    "造成9点伤害。 你的消耗牌堆中每有一张灵魂，伤害增加6。",
    0
  ],
  "Sow+": [
    "播种+",
    1,
    "Attack",
    "保留。 对所有敌人造成11点伤害。",
    0
  ],
  "SpiritOfAsh+": [
    "灰烬之灵+",
    1,
    "Power",
    "每当你打出一张虚无牌时，获得5点格挡。",
    0
  ],
  "Spur+": [
    "增生+",
    1,
    "Skill",
    "保留。 召唤5。 奥斯提回复7点生命。",
    0
  ],
  "Squeeze+": [
    "榨取+",
    3,
    "Attack",
    "奥斯提造成30点伤害。 你每有一张奥斯提的攻击牌，这张牌就额外造成6点伤害。",
    0
  ],
  "StrikeNecrobinder+": [
    "打击+",
    1,
    "Attack",
    "造成9点伤害。",
    0
  ],
  "TheScythe+": [
    "巨镰+",
    2,
    "Attack",
    "造成13点伤害。 这张牌在本局游戏中的伤害永久性增加7。 消耗。",
    0
  ],
  "TimesUp+": [
    "大限已至+",
    2,
    "Attack",
    "保留。 造成等量于该敌人身上的灾厄层数的伤害。",
    0
  ],
  "Transfigure+": [
    "重构+",
    1,
    "Skill",
    "给一张手牌添加重放。 其耗能增加11点能量。",
    0
  ],
  "Undeath+": [
    "不死+",
    0,
    "Skill",
    "获得9点格挡。 在弃牌堆放入一张此牌的复制品。",
    0
  ],
  "Unleash+": [
    "出击+",
    1,
    "Attack",
    "奥斯提造成9点伤害。 这张牌额外造成等量于奥斯提当前生命值的伤害。",
    0
  ],
  "Veilpiercer+": [
    "刺破帷幕+",
    1,
    "Attack",
    "造成13点伤害。 你打出的下一张虚无牌耗能变为01点能量。",
    0
  ],
  "Wisp+": [
    "鬼火+",
    0,
    "Skill",
    "保留。 获得1点能量。 消耗。",
    0
  ],
  "AdaptiveStrike+": [
    "适应打击+",
    2,
    "Attack",
    "造成23点伤害。 将这张牌的一张01点能量复制品添加到你的弃牌堆。",
    0
  ],
  "AllForOne+": [
    "万物一心+",
    2,
    "Attack",
    "造成14点伤害。 将你弃牌堆中的所有01点能量牌放入你的手牌。",
    0
  ],
  "BallLightning+": [
    "球状闪电+",
    1,
    "Attack",
    "造成10点伤害。 生成1个闪电充能球。",
    0
  ],
  "Barrage+": [
    "弹幕齐射+",
    1,
    "Attack",
    "当前每有一个充能球，造成7点伤害。",
    0
  ],
  "BeamCell+": [
    "光束射线+",
    0,
    "Attack",
    "造成4点伤害。 给予2层易伤。",
    0
  ],
  "BiasedCognition+": [
    "偏差认知+",
    1,
    "Power",
    "获得6点集中。 在你的回合开始时，失去1点集中。",
    0
  ],
  "BoostAway+": [
    "高速脱离+",
    0,
    "Skill",
    "获得9点格挡。 将一张晕眩添加到你的弃牌堆中。",
    0
  ],
  "BootSequence+": [
    "启动流程+",
    0,
    "Skill",
    "固有。 获得13点格挡。 消耗。",
    0
  ],
  "Buffer+": [
    "缓冲+",
    2,
    "Power",
    "阻止下2次你受到的生命值损伤。",
    0
  ],
  "BulkUp+": [
    "暴涨+",
    2,
    "Power",
    "失去1个充能球栏位。 获得3点力量。 获得3点敏捷。",
    0
  ],
  "Capacitor+": [
    "扩容+",
    1,
    "Power",
    "获得3个充能球栏位。",
    0
  ],
  "Chaos+": [
    "混沌+",
    1,
    "Skill",
    "生成2个随机充能球。",
    0
  ],
  "ChargeBattery+": [
    "充电+",
    1,
    "Skill",
    "获得10点格挡。 在下个回合获得1点能量。",
    0
  ],
  "Chill+": [
    "冰寒+",
    0,
    "Skill",
    "当前每有一名敌人，就生成1个冰霜充能球。",
    0
  ],
  "Claw+": [
    "爪击+",
    0,
    "Attack",
    "造成4点伤害。 本场战斗中所有爪击卡牌的伤害增加3点。",
    0
  ],
  "ColdSnap+": [
    "寒流+",
    1,
    "Attack",
    "造成9点伤害。 生成1个冰霜充能球。",
    0
  ],
  "Compact+": [
    "压缩+",
    1,
    "Skill",
    "获得7点格挡。 将你手牌中的全部状态牌变化为燃料+。",
    0
  ],
  "CompileDriver+": [
    "编译冲击+",
    1,
    "Attack",
    "造成10点伤害。 你每有一种不同的充能球，就抽一张牌。 （抽0张牌）",
    0
  ],
  "ConsumingShadow+": [
    "吞噬暗影+",
    2,
    "Power",
    "生成3个黑暗充能球。 在你的回合结束时，激发你最左侧的充能球。",
    0
  ],
  "Coolant+": [
    "冷却剂+",
    1,
    "Power",
    "在你的回合开始时，你每有一种不同的充能球，就获得3点格挡。",
    0
  ],
  "Coolheaded+": [
    "冷静头脑+",
    1,
    "Skill",
    "生成1个冰霜充能球。 抽2张牌。",
    0
  ],
  "CreativeAi+": [
    "创造性AI+",
    2,
    "Power",
    "在你的回合开始时，将一张随机能力牌加入你的手牌。",
    0
  ],
  "Darkness+": [
    "漆黑+",
    1,
    "Skill",
    "生成1个黑暗充能球。 触发所有黑暗充能球的被动两次。",
    0
  ],
  "DefendDefect+": [
    "防御+",
    1,
    "Skill",
    "获得8点格挡。",
    0
  ],
  "Defragment+": [
    "碎片整理+",
    1,
    "Power",
    "获得2点集中。",
    0
  ],
  "DoubleEnergy+": [
    "双倍能量+",
    0,
    "Skill",
    "将你的能量翻倍。 消耗。",
    0
  ],
  "Dualcast+": [
    "双重释放+",
    0,
    "Skill",
    "激发你最右侧的充能球两次。",
    0
  ],
  "EchoForm+": [
    "回响形态+",
    3,
    "Power",
    "你每回合打出的第一张牌会被打出两次。",
    0
  ],
  "Feral+": [
    "野性+",
    1,
    "Power",
    "你每回合打出的第一张 耗能为01点能量的攻击牌， 会放回你的手牌。",
    0
  ],
  "FightThrough+": [
    "强撑+",
    1,
    "Skill",
    "获得17点格挡。 将2张伤口加入你的弃牌堆。",
    0
  ],
  "FlakCannon+": [
    "散射炮+",
    2,
    "Attack",
    "消耗你所有的状态牌。 每有一张被消耗的牌，就随机对敌人造成11点伤害。",
    0
  ],
  "FocusedStrike+": [
    "集中打击+",
    1,
    "Attack",
    "造成11点伤害。 在本回合获得2点集中。",
    0
  ],
  "Ftl+": [
    "超越光速+",
    0,
    "Attack",
    "造成6点伤害。 如果你在这回合打出的牌数小于4张，抽1张牌。",
    0
  ],
  "Fusion+": [
    "聚变+",
    1,
    "Skill",
    "生成1个等离子充能球。",
    0
  ],
  "GeneticAlgorithm+": [
    "遗传算法+",
    1,
    "Skill",
    "获得1点格挡。 每打出一次，这张牌在本局游戏中的格挡值永久增加4点。 消耗。",
    0
  ],
  "Glacier+": [
    "冰川+",
    2,
    "Skill",
    "获得9点格挡。 生成2个冰霜充能球。",
    0
  ],
  "Glasswork+": [
    "玻璃工艺+",
    1,
    "Skill",
    "获得8点格挡。 生成1个玻璃充能球。",
    0
  ],
  "GoForTheEyes+": [
    "眼部攻击+",
    0,
    "Attack",
    "造成4点伤害。 如果敌人的意图是攻击，则给予2层虚弱。",
    0
  ],
  "GunkUp+": [
    "污秽攻击+",
    1,
    "Attack",
    "造成5点伤害3次。 在你的弃牌堆中加入一张黏液。",
    0
  ],
  "Hailstorm+": [
    "冰雹风暴+",
    1,
    "Power",
    "在你的回合结束时，如果你有冰霜充能球，则对所有敌人造成8点伤害。",
    0
  ],
  "HelixDrill+": [
    "螺旋钻击+",
    0,
    "Attack",
    "在本回合中，这张牌以外使用的每个1点能量，都会使此牌造成5点伤害一次。",
    0
  ],
  "Hologram+": [
    "全息影像+",
    1,
    "Skill",
    "获得5点格挡。 将弃牌堆中的一张牌放入你的手牌。",
    0
  ],
  "Hotfix+": [
    "热修复+",
    0,
    "Skill",
    "在本回合获得2点集中。",
    0
  ],
  "Hyperbeam+": [
    "超能光束+",
    2,
    "Attack",
    "对所有敌人造成30点伤害。 在本回合失去3点集中。",
    0
  ],
  "IceLance+": [
    "冰之长枪+",
    3,
    "Attack",
    "造成24点伤害。 生成3个冰霜充能球。",
    0
  ],
  "Iteration+": [
    "迭代+",
    1,
    "Power",
    "每回合你第一次抽到状态牌时，抽3张牌。",
    0
  ],
  "Leap+": [
    "飞跃+",
    1,
    "Skill",
    "获得12点格挡。",
    0
  ],
  "LightningRod+": [
    "引雷针+",
    1,
    "Skill",
    "获得7点格挡。 在下2个回合开始时,生成1个闪电充能球。",
    0
  ],
  "Loop+": [
    "循环+",
    1,
    "Power",
    "在你的回合开始时，触发你最右侧的一个充能球的被动能力2次。",
    0
  ],
  "MachineLearning+": [
    "机器学习+",
    1,
    "Power",
    "固有。 在你的回合开始时，额外抽1张牌。",
    0
  ],
  "MeteorStrike+": [
    "陨石打击+",
    5,
    "Attack",
    "造成30点伤害。 生成3个等离子充能球。",
    0
  ],
  "Modded+": [
    "模组改造+",
    0,
    "Skill",
    "获得1个充能球栏位。 抽2张牌。这张牌的耗能加1。",
    0
  ],
  "MomentumStrike+": [
    "趁势打击+",
    1,
    "Attack",
    "造成15点伤害。 这张牌的耗能降为01点能量。",
    0
  ],
  "MultiCast+": [
    "多重释放+",
    -1,
    "Skill",
    "激发你最右侧的充能球X+1次。",
    0
  ],
  "Null+": [
    "空值+",
    2,
    "Attack",
    "造成13点伤害。 给予2层虚弱。 生成1个黑暗充能球。",
    0
  ],
  "Overclock+": [
    "超频+",
    0,
    "Skill",
    "抽3张牌。 将一张灼伤加入你的弃牌堆。",
    0
  ],
  "Quadcast+": [
    "四重释放+",
    0,
    "Skill",
    "激发你最右侧的充能球4次。",
    0
  ],
  "Rainbow+": [
    "彩虹+",
    2,
    "Skill",
    "生成1个闪电充能球。 生成1个冰霜充能球。 生成1个黑暗充能球。",
    0
  ],
  "Reboot+": [
    "重启+",
    0,
    "Skill",
    "将你的所有未消耗的卡牌重新洗牌放入抽牌堆。 抽6张牌。 消耗。",
    0
  ],
  "Refract+": [
    "折射+",
    3,
    "Attack",
    "造成13点伤害两次。 生成2个玻璃充能球。",
    0
  ],
  "RocketPunch+": [
    "火箭飞拳+",
    2,
    "Attack",
    "造成14点伤害。 抽2张牌。 每当你生成状态牌时，此牌的耗能将在下一次打出前减少11点能量。",
    0
  ],
  "Scavenge+": [
    "内存清理+",
    1,
    "Skill",
    "消耗一张牌。 在下个回合获得3点能量。",
    0
  ],
  "Scrape+": [
    "刮削+",
    1,
    "Attack",
    "造成10点伤害。 抽5张牌。 丢弃抽到的牌中耗能不为01点能量的牌。",
    0
  ],
  "ShadowShield+": [
    "暗影之盾+",
    2,
    "Skill",
    "获得15点格挡。 生成1个黑暗充能球。",
    0
  ],
  "Shatter+": [
    "打碎+",
    1,
    "Attack",
    "对所有敌人造成11点伤害。 激发你的所有充能球两次。 消耗。",
    0
  ],
  "SignalBoost+": [
    "信号增强+",
    0,
    "Skill",
    "你的下一张能力牌会额外打出一次。 消耗。",
    0
  ],
  "Skim+": [
    "快速检索+",
    1,
    "Skill",
    "抽4张牌。",
    0
  ],
  "Smokestack+": [
    "烟囱+",
    1,
    "Power",
    "每当你生成一张状态牌时，对所有敌人造成7点伤害。",
    0
  ],
  "Spinner+": [
    "旋转工艺+",
    1,
    "Power",
    "生成1个玻璃充能球。 在你的回合开始时，生成1个玻璃充能球。",
    0
  ],
  "Storm+": [
    "雷暴+",
    1,
    "Power",
    "每当你打出一张能力牌时，生成2个闪电充能球。",
    0
  ],
  "StrikeDefect+": [
    "打击+",
    1,
    "Attack",
    "造成9点伤害。",
    0
  ],
  "Subroutine+": [
    "子程序+",
    0,
    "Power",
    "当你打出一张能力牌时，获得1点能量。",
    0
  ],
  "Sunder+": [
    "分离+",
    3,
    "Attack",
    "造成34点伤害。 如果这张牌击杀了敌人，则获得3点能量。",
    0
  ],
  "Supercritical+": [
    "超临界态+",
    0,
    "Skill",
    "获得61点能量。 消耗。",
    0
  ],
  "SweepingBeam+": [
    "扫荡射线+",
    1,
    "Attack",
    "对所有敌人造成9点伤害。 抽1张牌。",
    0
  ],
  "Synchronize+": [
    "同步+",
    1,
    "Skill",
    "你每有一种不同的充能球，就在本回合获得2点集中。",
    0
  ],
  "Synthesis+": [
    "人工合成+",
    2,
    "Attack",
    "造成20点伤害。 你打出的下一张能力牌耗能变为01点能量。",
    0
  ],
  "Tempest+": [
    "暴风雨+",
    -1,
    "Skill",
    "生成X+1个闪电充能球。",
    0
  ],
  "TeslaCoil+": [
    "特斯拉线圈+",
    0,
    "Attack",
    "造成4点伤害。 对该敌人触发你的所有闪电充能球的被动两次。",
    0
  ],
  "Thunder+": [
    "雷霆+",
    1,
    "Power",
    "每当你激发闪电充能球时，对被命中的敌人造成11点伤害。",
    0
  ],
  "TrashToTreasure+": [
    "化废为宝+",
    0,
    "Power",
    "每当你生成状态牌的时候，随机生成一个充能球。",
    0
  ],
  "Turbo+": [
    "内核加速+",
    0,
    "Skill",
    "获得3点能量。 将一张虚空加入你的弃牌堆。",
    0
  ],
  "Uproar+": [
    "骚动+",
    2,
    "Attack",
    "造成8点伤害两次。 随机打出你的抽牌堆中的1张攻击牌。",
    0
  ],
  "Voltaic+": [
    "电流相生+",
    3,
    "Skill",
    "生成等量于你在这场战斗中生成过的闪电充能球数量的闪电充能球。",
    0
  ],
  "WhiteNoise+": [
    "白噪声+",
    0,
    "Skill",
    "将一张随机能力牌加入你的手牌。这张牌在本回合内免费打出。 消耗。",
    0
  ],
  "Zap+": [
    "电击+",
    0,
    "Skill",
    "生成1个闪电充能球。",
    0
  ],
  "Alchemize+": [
    "炼制药水+",
    0,
    "Skill",
    "获得一瓶随机药水。 消耗。",
    0
  ],
  "Anointed+": [
    "天选+",
    1,
    "Skill",
    "保留。 将你抽牌堆中的所有稀有牌放入你的手牌。 消耗。",
    0
  ],
  "Automation+": [
    "自动化+",
    0,
    "Power",
    "你每抽10张牌，获得1点能量。",
    0
  ],
  "BeatDown+": [
    "狠揍+",
    3,
    "Skill",
    "打出你弃牌堆中的4张随机攻击牌。",
    0
  ],
  "Bolas+": [
    "流星锤+",
    0,
    "Attack",
    "造成4点伤害。 在你的下个回合开始时，将此卡返回你的手牌。",
    0
  ],
  "Calamity+": [
    "劫难+",
    2,
    "Power",
    "每当你打出一张攻击牌时，将一张随机攻击牌添加到你的手牌。",
    0
  ],
  "Catastrophe+": [
    "横祸+",
    2,
    "Skill",
    "从你的抽牌堆中随机打出3张牌。",
    0
  ],
  "DarkShackles+": [
    "黑暗镣铐+",
    0,
    "Skill",
    "使一名敌人在本回合失去15点力量。 消耗。",
    0
  ],
  "Discovery+": [
    "发现+",
    1,
    "Skill",
    "从3张随机牌中选择1张加入你的手牌。这张牌在本回合可以免费打出。",
    0
  ],
  "DramaticEntrance+": [
    "闪亮登场+",
    0,
    "Attack",
    "固有。 对所有敌人造成15点伤害。 消耗。",
    0
  ],
  "Entropy+": [
    "熵+",
    1,
    "Power",
    "固有。 在你的回合开始时，变化你手牌中的1张牌。",
    0
  ],
  "Equilibrium+": [
    "均衡+",
    2,
    "Skill",
    "获得16点格挡。 在本回合保留你的手牌。",
    0
  ],
  "EternalArmor+": [
    "永恒铠甲+",
    3,
    "Power",
    "获得12层覆甲。",
    0
  ],
  "Fasten+": [
    "勒紧+",
    1,
    "Power",
    "从“防御”牌中额外获得6点格挡。",
    0
  ],
  "Finesse+": [
    "妙计+",
    0,
    "Skill",
    "获得7点格挡。 抽1张牌。",
    0
  ],
  "Fisticuffs+": [
    "拳斗+",
    1,
    "Attack",
    "造成9点伤害。 获得等量于所造成伤害的格挡。",
    0
  ],
  "FlashOfSteel+": [
    "亮剑+",
    0,
    "Attack",
    "造成8点伤害。 抽1张牌。",
    0
  ],
  "GoldAxe+": [
    "金斧+",
    1,
    "Attack",
    "保留。 造成本场战斗中所打出牌数的伤害。",
    0
  ],
  "HandOfGreed+": [
    "贪婪之手+",
    2,
    "Attack",
    "造成25点伤害。 斩杀时，获得25金币。",
    0
  ],
  "HiddenGem+": [
    "未掘宝石+",
    1,
    "Skill",
    "你抽牌堆中的一张没有重放的随机牌获得3层重放。",
    0
  ],
  "Impatience+": [
    "急躁+",
    0,
    "Skill",
    "如果你的手牌中没有攻击牌，抽3张牌。",
    0
  ],
  "JackOfAllTrades+": [
    "花样百出+",
    0,
    "Skill",
    "将2张随机无色牌加入你的手牌。 消耗。",
    0
  ],
  "Jackpot+": [
    "大奖+",
    3,
    "Attack",
    "造成30点伤害。 将3张随机升级过的01点能量的牌加入你的手牌。",
    0
  ],
  "MasterOfStrategy+": [
    "战略大师+",
    0,
    "Skill",
    "抽4张牌。 消耗。",
    0
  ],
  "Mayhem+": [
    "乱战+",
    1,
    "Power",
    "在你的回合开始时，打出你抽牌堆顶部的牌。",
    0
  ],
  "MindBlast+": [
    "心灵震慑+",
    0,
    "Attack",
    "固有。 造成你抽牌堆中剩余牌数的伤害。",
    0
  ],
  "Nostalgia+": [
    "怀旧+",
    0,
    "Power",
    "每回合首次打出攻击或技能牌时，将其置于你的抽牌堆顶端。",
    0
  ],
  "Omnislice+": [
    "万向斩+",
    0,
    "Attack",
    "造成11点伤害。 对所有其他敌人造成等量的伤害。",
    0
  ],
  "Panache+": [
    "神气制胜+",
    0,
    "Power",
    "每当你在一回合内打出五张牌时，对所有敌人造成14点伤害。",
    0
  ],
  "PanicButton+": [
    "应急按钮+",
    0,
    "Skill",
    "获得40点格挡。 你在接下来的2回合内无法再从卡牌中获得格挡。 消耗。",
    0
  ],
  "PrepTime+": [
    "准备时间+",
    1,
    "Power",
    "在你的回合开始时，获得6点活力。",
    0
  ],
  "Production+": [
    "生产制造+",
    0,
    "Skill",
    "获得3点能量。 消耗。",
    0
  ],
  "Prolong+": [
    "延伸+",
    0,
    "Skill",
    "在下个回合获得等量于你当前格挡值的格挡。",
    0
  ],
  "Prowess+": [
    "非凡技艺+",
    1,
    "Power",
    "获得2点力量。 获得2点敏捷。",
    0
  ],
  "Purity+": [
    "净化+",
    0,
    "Skill",
    "保留。 从手牌中选择最多5张牌消耗。 消耗。",
    0
  ],
  "Rend+": [
    "撕碎+",
    1,
    "Attack",
    "造成12点伤害。 该名敌人身上每有一种负面效果，就额外造成8点伤害。",
    0
  ],
  "Restlessness+": [
    "心神不宁+",
    0,
    "Skill",
    "保留。 如果你的手牌为空，则抽3张牌并获得3点能量。",
    0
  ],
  "RollingBoulder+": [
    "滚石+",
    3,
    "Power",
    "在你的回合开始时，对所有敌人造成10点伤害，然后将该伤害增加5点。",
    0
  ],
  "Salvo+": [
    "箭雨+",
    1,
    "Attack",
    "造成16点伤害。 在本回合保留你的手牌。",
    0
  ],
  "Scrawl+": [
    "潦草急就+",
    1,
    "Skill",
    "保留。 抽牌直到抽满手牌。 消耗。",
    0
  ],
  "SecretTechnique+": [
    "秘密技法+",
    0,
    "Skill",
    "从抽牌堆中选择一张技能牌放入你的手牌。",
    0
  ],
  "SecretWeapon+": [
    "秘密武器+",
    0,
    "Skill",
    "从抽牌堆中选择一张攻击牌放入你的手牌。",
    0
  ],
  "SeekerStrike+": [
    "探寻打击+",
    1,
    "Attack",
    "造成12点伤害。 从抽牌堆的随机3张牌中选择一张加入你的手牌。",
    0
  ],
  "Shockwave+": [
    "震荡波+",
    2,
    "Skill",
    "给予所有敌人5层虚弱和易伤。 消耗。",
    0
  ],
  "Splash+": [
    "飞溅+",
    1,
    "Skill",
    "从3张其他角色的升级过的攻击牌中选择1张加入你的手牌。这张牌在本回合免费打出。",
    0
  ],
  "Stratagem+": [
    "计策+",
    0,
    "Power",
    "每当你的抽牌堆打乱洗牌时，选择一张牌放入你的手牌。",
    0
  ],
  "TheBomb+": [
    "炸弹+",
    2,
    "Skill",
    "在3回合结束后，对所有敌人造成50点伤害。",
    0
  ],
  "TheGambit+": [
    "孤注一掷+",
    0,
    "Skill",
    "获得75点格挡。 如果你在本场战斗中受到未被格挡的攻击伤害，则立刻死亡。",
    0
  ],
  "ThinkingAhead+": [
    "深谋远虑+",
    0,
    "Skill",
    "抽2张牌。 将手牌中的一张牌放到你的抽牌堆的顶端。",
    0
  ],
  "ThrummingHatchet+": [
    "无休手斧+",
    1,
    "Attack",
    "造成14点伤害。 在你的下个回合开始时，将此卡返回你的手牌。",
    0
  ],
  "UltimateDefend+": [
    "究极防御+",
    1,
    "Skill",
    "获得15点格挡。",
    0
  ],
  "UltimateStrike+": [
    "究极打击+",
    1,
    "Attack",
    "造成20点伤害。",
    0
  ],
  "Volley+": [
    "连射+",
    -1,
    "Attack",
    "随机对敌人造成14点伤害X次。",
    0
  ],
  "Abundance+": [
    "富足+",
    0,
    "Skill",
    "从3张升级过的能力牌中选择1张加入你的手牌。这张牌在本回合可以免费打出。 消耗。",
    0
  ],
  "Apotheosis+": [
    "神化+",
    1,
    "Skill",
    "固有。 升级你的全部卡牌。 消耗。",
    0
  ],
  "Apparition+": [
    "灵体+",
    1,
    "Skill",
    "获得1层无实体。 消耗。",
    0
  ],
  "BrightestFlame+": [
    "至亮之焰+",
    0,
    "Skill",
    "获得3点能量。 抽3张牌。 失去2点最大生命。",
    0
  ],
  "ByrdSwoop+": [
    "异鸟扑击+",
    0,
    "Attack",
    "造成18点伤害。",
    0
  ],
  "Caltrops+": [
    "铁蒺藜+",
    1,
    "Power",
    "每当你被攻击时，对攻击者造成5点伤害。",
    0
  ],
  "Clash+": [
    "交锋+",
    0,
    "Attack",
    "只有在手牌中每一张牌都是攻击牌时才能被打出。 造成18点伤害。",
    0
  ],
  "Distraction+": [
    "声东击西+",
    0,
    "Skill",
    "将一张随机技能牌添加到你的手牌中。这张牌在本回合内可以免费打出。 消耗。",
    0
  ],
  "DualWield+": [
    "双持+",
    1,
    "Skill",
    "选择一张攻击牌或能力牌。将该牌的2张复制品加入你的手牌。",
    0
  ],
  "Enlightenment+": [
    "开悟+",
    0,
    "Skill",
    "在这场战斗，你当前手牌中所有牌的耗能降低至1。 消耗。",
    0
  ],
  "Entrench+": [
    "巩固+",
    1,
    "Skill",
    "将你当前的格挡翻倍。",
    0
  ],
  "Exterminate+": [
    "杀灭+",
    1,
    "Attack",
    "对所有敌人造成4点伤害4次。",
    0
  ],
  "FeedingFrenzy+": [
    "疯狂进食+",
    0,
    "Skill",
    "在本回合内获得7点力量。",
    0
  ],
  "HelloWorld+": [
    "你好世界+",
    1,
    "Power",
    "固有。 在你的回合开始时，将一张随机普通牌加入你的手牌。",
    0
  ],
  "MadScience+": [
    "疯狂科学+",
    1,
    "None",
    "固有。 ？？？？？？",
    0
  ],
  "Maul+": [
    "撕咬+",
    1,
    "Attack",
    "造成6点伤害两次。 在这场战斗中，将所有“撕咬”牌的伤害增加3。",
    0
  ],
  "Metamorphosis+": [
    "羽化+",
    2,
    "Skill",
    "在你的抽牌堆中加入5张随机攻击牌。它们在本场战斗中可以被免费打出。 消耗。",
    0
  ],
  "NeowsFury+": [
    "涅奥之怒+",
    1,
    "Attack",
    "造成14点伤害。 将你弃牌堆中的至多3张牌放入你的手牌。 消耗。",
    0
  ],
  "Outmaneuver+": [
    "抢占先机+",
    1,
    "Skill",
    "在下个回合获得3点能量。",
    0
  ],
  "Peck+": [
    "啄击+",
    1,
    "Attack",
    "造成2点伤害4次。",
    0
  ],
  "Rebound+": [
    "弹回+",
    1,
    "Attack",
    "造成12点伤害。 将你在本回合打出的下一张牌放置到你的抽牌堆顶部。",
    0
  ],
  "Relax+": [
    "放松+",
    3,
    "Skill",
    "获得18点格挡。 下个回合，抽3张牌并获得3点能量。 消耗。",
    0
  ],
  "RipAndTear+": [
    "狂乱撕扯+",
    1,
    "Attack",
    "随机对敌人造成9点伤害两次。",
    0
  ],
  "Squash+": [
    "压扁+",
    1,
    "Attack",
    "造成12点伤害。 给予3层易伤。",
    0
  ],
  "Stack+": [
    "堆栈+",
    1,
    "Skill",
    "获得等量于与你当前弃牌堆中牌数+3的格挡值。",
    0
  ],
  "ToricToughness+": [
    "坚韧之环+",
    2,
    "Skill",
    "获得7点格挡。 在接下来的2个回合开始时，获得7点格挡。",
    0
  ],
  "Wish+": [
    "许愿+",
    0,
    "Skill",
    "保留。 将你抽牌堆中的一张牌放入你的手牌。 消耗。",
    0
  ],
  "Whistle+": [
    "吹哨+",
    2,
    "Attack",
    "造成44点伤害。 击晕该敌人。 消耗。",
    0
  ],
  "Fuel+": [
    "燃料+",
    0,
    "Skill",
    "获得2点能量。 消耗。",
    0
  ],
  "GiantRock+": [
    "巨石+",
    1,
    "Attack",
    "造成24点伤害。",
    0
  ],
  "Luminesce+": [
    "冷光+",
    0,
    "Skill",
    "保留。 获得3点能量。 消耗。",
    0
  ],
  "MinionDiveBomb+": [
    "仆从俯冲+",
    0,
    "Attack",
    "造成16点伤害。 消耗。",
    0
  ],
  "MinionSacrifice+": [
    "仆从捐躯+",
    0,
    "Skill",
    "获得10点格挡。 消耗。",
    0
  ],
  "MinionStrike+": [
    "仆从打击+",
    0,
    "Attack",
    "造成9点伤害。 抽1张牌。 消耗。",
    0
  ],
  "Shiv+": [
    "小刀+",
    0,
    "Attack",
    "造成6点伤害。 消耗。",
    0
  ],
  "Soul+": [
    "灵魂+",
    0,
    "Skill",
    "抽3张牌。 消耗。",
    0
  ],
  "SovereignBlade+": [
    "君王之剑+",
    1,
    "Attack",
    "保留。 造成10点伤害。",
    0
  ],
  "SweepingGaze+": [
    "扫荡凝视+",
    0,
    "Attack",
    "虚无。 奥斯提对随机一名敌人造成15点伤害。 消耗。",
    0
  ]
});
// END NATIVE 0.111.1 UPGRADED CARD DISPLAY

const DUEL_STARTING_HP = { Ironclad: 80 + 6, Silent: 70, Regent: 75, Necrobinder: 66, Defect: 75 };

function duelFighter(player, random) {
    const deck = sample(random, player.deck.map((id) => ({ id })), player.deck.length);
    const innate = deck.filter((card) => duelEffect(card.id).innate);
    return {
        job: player.job, totalDrawn: 0, hp: DUEL_STARTING_HP[player.job], block: 0, weak: 0, vulnerable: 0, poison: 0, doom: 0, poisonPerRound: 0,
        stars: player.job === "Regent" ? 3 : 0,
        osty: player.job === "Necrobinder" ? 1 : 0,
        ostyMax: player.job === "Necrobinder" ? 1 : 0,
        strength: 0, dexterity: 0, starsPerRound: 0, ostyDamage: 0, orbSlots: 3,
        shivDamage: 0, shivsPerRound: 0, exhaustedSouls: 0,
        orbs: player.job === "Defect" ? [{ kind: "lightning" }] : [],
        deck: deck.filter((card) => !duelEffect(card.id).innate), innate, discard: [], retained: [],
        nextBlock: 0, nextStars: 0, nextDraw: 0, nextEnergy: 0,
        starCards: deck.filter((card) => GAME_CARDS[card.id][4] > 0).length,
        exhausted: 0, strengthPerRound: 0, energyPerRound: 0, drawPerRound: 0,
        doomPerRound: 0, blockOnExhaust: 0, drawOnExhaust: 0, tracking: false,
        bladeForge: 0, forgePerRound: 0, vigor: 0, starsOnPlay: 0, nextSummon: 0,
        focus: 0, hailstorm: 0, lightningRounds: 0, afterimage: 0, clawDamage: 0, keepBlock: false,
        enemyStrengthLoss: 0, permanentEnemyStrengthLoss: 0,
    };
}

function duelDraw(actor, hand, count, random) {
    let energyLoss = 0;
    if (actor.stopDraw) return energyLoss;
    for (let i = 0; i < count; i++) {
        if (!actor.deck.length) {
            actor.deck = sample(random, actor.discard, actor.discard.length);
            actor.discard = [];
        }
        if (!actor.deck.length) break;
        const card = actor.deck.pop();
        hand.push(card);
        actor.totalDrawn++;
        const effect = duelEffect(card.id);
        card.discount = (card.discount ?? 0) + (effect.discountOnDraw ?? 0);
        card.damage = (card.damage ?? 0) + (effect.damageOnDraw ?? 0);
        energyLoss += effect.energyLossOnDraw ?? 0;
    }
    return energyLoss;
}

function duelDamage(actor, target, { base, attack, vulnerable, directLoss }) {
    if (directLoss) {
        target.hp = Math.max(0, target.hp - base);
        return { damage: base, blocked: 0 };
    }
    if (attack) base = Math.max(0, base - actor.enemyStrengthLoss - actor.permanentEnemyStrengthLoss);
    const scaled = attack ? base * (actor.weak ? 0.75 : 1) * (vulnerable ? 1.5 + (actor.cruelty ?? 0) : 1)
        * (actor.tracking && target.weak ? 2 : 1) : base;
    let damage = Math.floor(scaled);
    const blocked = Math.min(target.block, damage);
    target.block -= blocked;
    damage -= blocked;
    if (attack && damage > 0) target.poison += actor.envenom ?? 0;
    const absorbed = Math.min(target.osty, damage);
    target.osty -= absorbed;
    if (!target.osty) target.ostyMax = 0;
    let hpLoss = damage - absorbed;
    if (hpLoss && target.buffer) {
        target.buffer--;
        hpLoss = 0;
    }
    if (hpLoss && attack && target.plating) target.plating--;
    target.hp = Math.max(0, target.hp - hpLoss);
    return { damage: damage + blocked, blocked };
}

function duelOrb(actor, hits, orb, evoke) {
    const focus = actor.focus + actor.temporaryFocus;
    if (orb.kind === "frost") actor.block += Math.max(0, (evoke ? 5 : 2) + focus);
    if (orb.kind === "lightning") hits.push({ base: Math.max(0, (evoke ? 8 : 3) + focus), attack: false });
    if (orb.kind === "glass") {
        const value = Math.max(0, orb.charge + focus);
        hits.push({ base: value * (evoke ? 2 : 1), attack: false });
        if (!evoke) orb.charge = Math.max(0, orb.charge - 1);
    }
    if (orb.kind === "dark") {
        if (evoke) hits.push({ base: orb.charge, attack: false });
        else orb.charge += Math.max(0, 6 + focus);
    }
}

function duelTurn(actor, target, round, random) {
    const hand = actor.retained;
    actor.retained = [];
    actor.block = (actor.keepBlock || actor.keepBlockNext ? actor.block : 0) + actor.nextBlock;
    actor.keepBlockNext = false;
    actor.stopDraw = false;
    actor.discardedThisRound = 0;
    actor.extraDrawn = 0;
    actor.ostyHits = 0;
    actor.block += (actor.mantle ?? 0) + (actor.coolant ?? 0) * new Set(actor.orbs.map((orb) => orb.kind)).size;
    actor.hp = Math.max(0, actor.hp - (actor.mantleCount ?? 0));
    actor.strength += actor.strengthPerRound;
    actor.nextBlock = 0;
    actor.played = { Attack: 0, Skill: 0, Power: 0 };
    actor.starsGained = actor.starsPerRound + actor.nextStars;
    actor.stars += actor.starsGained;
    actor.nextStars = 0;
    let ostyAttacked = false;
    const hits = [];
    let conditionalWeak = 0;
    const playedInstances = new Set();
    const names = [];
    let energy = 3 + actor.nextEnergy + actor.energyPerRound;
    actor.nextEnergy = 0;
    let freePower = false;
    let freeAttack = false;
    let doubleBlade = false;
    let temporaryStrength = 0;
    let extraCost = 0;
    let strengthOnPlay = 0;
    let retainHand = false;
    let doubleBlock = false;
    energy += actor.orbs.filter((orb) => orb.kind === "plasma").length;
    const starChanged = (amount) => {
        if (amount > 0) actor.starsGained += amount;
        actor.stars += amount;
        if (amount && actor.blackHole) hits.push({ base: actor.blackHole, attack: false });
    };
    if (actor.starsGained && actor.blackHole) hits.push({ base: actor.blackHole, attack: false });
    let freeSkill = false;
    let doomOnPlay = 0;
    let doomApplied = false;
    let temporaryDexterity = 0;
    const initialExhausted = actor.exhausted;
    actor.temporaryFocus = 0;
    actor.ostyMax += actor.nextSummon;
    actor.osty += actor.nextSummon;
    actor.nextSummon = 0;
    const forge = (amount) => {
        if (!actor.bladeForge) hand.push({ id: "SovereignBlade" });
        actor.bladeForge += amount;
    };
    const triggerOrb = (orb, evoke) => {
        if (orb.kind === "plasma") energy += evoke ? 2 : 1;
        else duelOrb(actor, hits, orb, evoke);
    };
    const channel = (kind) => {
        if (!actor.orbSlots) return;
        if (actor.orbs.length === actor.orbSlots) triggerOrb(actor.orbs.shift(), true);
        actor.orbs.push({ kind, charge: kind === "glass" ? 4 : 6 });
    };
    for (let i = 0; i < (actor.loop ?? 0) && actor.orbs.length; i++) triggerOrb(actor.orbs[0], false);
    const openingStart = hand.length;
    const innate = round === 1 ? actor.innate : [];
    hand.push(...innate);
    const drawCount = round === 1 && actor.job === "Silent" ? 7 : 5;
    energy = Math.max(0, energy - duelDraw(actor, hand, Math.max(0, drawCount - innate.length) + actor.nextDraw + actor.drawPerRound, random));
    actor.nextDraw = 0;
    const openingDraw = hand.slice(openingStart).map((card) => GAME_CARDS[card.id][0]);
    for (let i = 0; i < actor.shivsPerRound; i++) hand.push({ id: "Shiv" });
    if (actor.forgePerRound) forge(actor.forgePerRound);
    if (actor.lightningRounds) {
        channel("lightning");
        actor.lightningRounds--;
    }
    const extraDraw = [];
    const drawCards = (count) => {
        const start = hand.length;
        energy = Math.max(0, energy - duelDraw(actor, hand, count, random));
        actor.extraDrawn += hand.length - start;
        for (let i = start; i < hand.length; i++) extraDraw.push(GAME_CARDS[hand[i].id][0]);
    };
    const exhaust = (card) => {
        actor.exhausted++;
        energy += duelEffect(card.id).exhaustEnergy ?? 0;
        if (card.id === "Soul") actor.exhaustedSouls++;
        actor.block += actor.blockOnExhaust;
        if (actor.drawOnExhaust) drawCards(actor.drawOnExhaust);
    };
    const energyCost = (card) => {
        const [, baseCost, type] = GAME_CARDS[card.id];
        const effect = duelEffect(card.id);
        if (card.sly || (effect.freeAfterOsty && ostyAttacked)
            || (freePower && type === "Power") || (freeSkill && type === "Skill") || (freeAttack && type === "Attack")) return 0;
        if (effect.xEnergy) return energy;
        return Math.max(0, baseCost + extraCost - (actor.played[effect.discount] ?? 0) - (card.discount ?? 0));
    };
    for (;;) {
        const index = hand.findIndex((card) => {
            const starCost = GAME_CARDS[card.id][4] ?? 0;
            const effect = duelEffect(card.id);
            return !effect.unplayable && (!effect.emptyDeck || actor.deck.length === 0) && starCost <= actor.stars && energyCost(card) <= energy
                && (!effect.osty || actor.osty > 0) && (!effect.evoke || actor.orbs.length > 0);
        });
        if (index === -1) break;
        const [card] = hand.splice(index, 1);
        const [name, , type, , starCost = 0] = GAME_CARDS[card.id];
        const effect = duelEffect(card.id);
        const cost = energyCost(card);
        energy -= cost;
        if (type === "Power") freePower = false;
        if (type === "Skill" && !card.sly) freeSkill = false;
        delete card.sly;
        if (type === "Attack") freeAttack = false;
        temporaryStrength += strengthOnPlay;
        starChanged(actor.starsOnPlay);
        actor.hp = Math.max(0, actor.hp - (effect.hpLoss ?? 0));
        actor.hp = Math.min(DUEL_STARTING_HP[actor.job], actor.hp + (effect.heal ?? 0));
        starChanged(-starCost);
        actor.block += starCost * (actor.blockPerStar ?? 0);
        const blockBefore = actor.block;
        names.push(name);
        const rawBlock = typeof effect.block === "function" ? effect.block(actor, target) : effect.block;
        const block = rawBlock ? Math.max(0, rawBlock + actor.dexterity + temporaryDexterity) : 0;
        if (actor.exhausted > initialExhausted && effect.blockIfExhausted) {
            actor.block += Math.max(0, effect.blockIfExhausted + actor.dexterity + temporaryDexterity);
        }
        if (doomApplied) actor.block += block * (effect.repeatBlockOnDoom ?? 0);
        actor.block += block + actor.afterimage;
        if (effect.repeatBlockNextRound) actor.nextBlock += block;
        actor.nextStars += effect.nextStars ?? 0;
        actor.nextDraw += effect.nextDraw ?? 0;
        actor.nextBlock += effect.nextBlock ?? 0;
        actor.nextEnergy += effect.nextEnergy ?? 0;
        const hit = typeof effect.hit === "function" ? effect.hit(actor, target) : effect.hit;
        const hitCount = effect.xEnergy ? cost : effect.hits?.(actor, target, hand) ?? 1;
        for (let n = 0; hit && n < hitCount; n++) {
            hits.push({ base: Math.max(0, hit + actor.strength + temporaryStrength + actor.vigor + (card.damage ?? 0) + (effect.osty ? actor.ostyDamage : 0))
                * (card.id === "SovereignBlade" && doubleBlade ? 2 : 1),
                attack: true, vulnerable: target.vulnerable > 0, doomOnHit: effect.doomOnHit });
        }
        if (hit && hitCount > 0) actor.vigor = 0;
        if (effect.osty && hit) {
            ostyAttacked = true;
            actor.ostyHits += hitCount;
        }
        if (effect.sacrificeOsty) {
            actor.osty = 0;
            actor.ostyMax = 0;
        }
        if (card.id === "GoForTheEyes") conditionalWeak += effect.weak;
        else target.weak += effect.weak ?? 0;
        target.vulnerable += effect.vulnerable ?? 0;
        target.poison += typeof effect.poison === "function" ? effect.poison(actor, target) : effect.poison ?? 0;
        if (effect.doubleVulnerable) target.vulnerable *= 2;
        target.enemyStrengthLoss += effect.enemyStrengthLoss ?? 0;
        target.permanentEnemyStrengthLoss += effect.permanentEnemyStrengthLoss ?? 0;
        if (effect.directLoss) hits.push({ base: effect.directLoss, directLoss: true });
        const doom = typeof effect.doom === "function" ? effect.doom(actor, target) : effect.doom ?? 0;
        target.doom += doom + doomOnPlay;
        doomApplied ||= doom + doomOnPlay > 0;
        doomOnPlay += effect.doomOnPlay ?? 0;
        actor.poisonPerRound += effect.poisonPerRound ?? 0;
        starChanged(effect.stars ?? 0);
        actor.strength += effect.strengthFromVulnerable ? target.vulnerable : 0;
        temporaryStrength += effect.temporaryStrength ?? 0;
        strengthOnPlay += effect.strengthOnPlay ?? 0;
        freeAttack ||= Boolean(effect.freeAttack);
        retainHand ||= Boolean(effect.retainHand);
        actor.keepBlockNext ||= Boolean(effect.keepBlockNext);
        extraCost += effect.extraCost ?? 0;
        for (const key of ["mantle","cruelty","thorns","extraPoisonTicks","envenom","blackHole","blockPerStar","plating","parry","summonOnSoul","lossOnSoul","buffer","coolant","loop"]) {
            if (effect[key]) actor[key] = (actor[key] ?? 0) + effect[key];
        }
        if (effect.mantle) actor.mantleCount = (actor.mantleCount ?? 0) + 1;
        if (card.id === "SovereignBlade") actor.block += actor.parry ?? 0;
        if (effect.fillDebris) while (hand.length < 10) hand.push({ id: "Debris" });
        if (effect.lightningPerEnergy) for (let n = 0; n < cost; n++) channel("lightning");
        actor.strength += effect.strength ?? 0;
        actor.strengthPerRound += effect.strengthPerRound ?? 0;
        actor.energyPerRound += effect.energyPerRound ?? 0;
        actor.drawPerRound += effect.drawPerRound ?? 0;
        actor.doomPerRound += effect.doomPerRound ?? 0;
        actor.afterimage += effect.afterimage ?? 0;
        actor.clawDamage += effect.clawDamage ?? 0;
        actor.keepBlock ||= Boolean(effect.keepBlock);
        freePower ||= Boolean(effect.freePower);
        freeSkill ||= Boolean(effect.freeSkill);
        temporaryDexterity += effect.temporaryDexterity ?? 0;
        actor.vigor += effect.vigor ?? 0;
        actor.starsOnPlay += effect.starsOnPlay ?? 0;
        actor.forgePerRound += effect.forgePerRound ?? 0;
        if (effect.forge) forge(effect.forge);
        doubleBlade ||= Boolean(effect.doubleBlade);
        actor.nextSummon += effect.nextSummon ?? 0;
        actor.focus += effect.focus ?? 0;
        actor.temporaryFocus += typeof effect.temporaryFocus === "function"
            ? effect.temporaryFocus(actor) : effect.temporaryFocus ?? 0;
        actor.hailstorm += effect.hailstorm ?? 0;
        actor.lightningRounds = Math.max(actor.lightningRounds, effect.lightningRounds ?? 0);
        if (effect.triggerLightning) {
            for (const orb of actor.orbs) if (orb.kind === "lightning") duelOrb(actor, hits, orb, false);
        }
        actor.dexterity += effect.dexterity ?? 0;
        actor.starsPerRound += effect.starsPerRound ?? 0;
        actor.ostyDamage += effect.ostyDamage ?? 0;
        actor.orbSlots = Math.max(0, actor.orbSlots + (effect.orbSlots ?? 0));
        while (actor.orbs.length > actor.orbSlots) actor.orbs.pop();
        const soulPlay = card.id === "Soul";
        const summon = (effect.summon ?? 0) + (effect.summonPerEnergy ?? 0) * cost
            + (soulPlay ? actor.summonOnSoul ?? 0 : 0);
        actor.ostyMax += summon;
        actor.osty = Math.min(actor.ostyMax, actor.osty + summon + (effect.healOsty ?? 0));
        if (soulPlay && actor.lossOnSoul) hits.push({ base: actor.lossOnSoul, directLoss: true });
        for (const kind of effect.orbs ?? (effect.orb ? [effect.orb] : [])) {
            channel(kind);
        }
        if (effect.evoke) {
            const count = effect.xEnergy ? cost : effect.evoke === true ? 2 : effect.evoke;
            if (count > 0) {
                const orb = actor.orbs.shift();
                for (let n = 0; n < count; n++) triggerOrb(orb, true);
            }
        }
        actor.shivDamage += effect.shivDamage ?? 0;
        actor.shivsPerRound += effect.shivsPerRound ?? 0;
        for (let n = 0; n < (effect.shivs ?? 0); n++) hand.push({ id: "Shiv" });
        for (let n = 0; n < (effect.souls ?? 0) + (effect.soulsPerEnergy ?? 0) * cost; n++) {
            const index = Math.floor(random() * (actor.deck.length + 1));
            actor.deck.splice(index, 0, { id: "Soul" });
        }
        if (effect.dazed) actor.discard.push({ id: "Dazed" });
        for (let i = 0; i < (effect.discardCopies ?? 1) && effect.addToDiscard; i++) {
            actor.discard.push({ id: effect.addToDiscard });
        }
        if (effect.recoverDiscard && actor.discard.length) actor.deck.push(actor.discard.pop());
        if (effect.addToHand) hand.push({ id: effect.addToHand });
        for (let i = 0; i < Number(effect.recoverToHand ?? 0) && actor.discard.length; i++) {
            hand.push(actor.discard.pop());
        }
        if (effect.exhaustDrawTop && actor.deck.length) exhaust(actor.deck.pop());
        if (effect.transformDrawTop && actor.deck.length) actor.deck[actor.deck.length - 1] = { id: effect.transformDrawTop };
        if (effect.exhaustHand === "nonAttack") {
            const removed = hand.filter((item) => GAME_CARDS[item.id][2] !== "Attack");
            for (const item of removed) hand.splice(hand.indexOf(item), 1);
            for (const item of removed) {
                actor.block += Math.max(0, effect.blockPerExhaust + actor.dexterity + temporaryDexterity);
                exhaust(item);
            }
        } else if (effect.exhaustHand && hand.length) {
            const pos = effect.exhaustHand === "random" ? Math.floor(random() * hand.length) : 0;
            exhaust(hand.splice(pos, 1)[0]);
        }
        energy += effect.energy ?? 0;
        if (actor.exhausted > initialExhausted) energy += effect.energyIfExhausted ?? 0;
        if (effect.doubleEnergy) energy *= 2;
        const draw = typeof effect.draw === "function" ? effect.draw(actor)
            : effect.draw ?? (playedInstances.has(card) ? 0 : effect.drawOnce ?? 0);
        drawCards(draw);
        if (effect.putBack && hand.length) actor.deck.push(hand.shift());
        if (effect.damageAfterPlay) card.damage = (card.damage ?? 0) + effect.damageAfterPlay;
        if (effect.discard && index < hand.length) {
            const [discarded] = hand.splice(index, 1);
            actor.discardedThisRound++;
            if (duelEffect(discarded.id).sly) {
                discarded.sly = true;
                hand.unshift(discarded);
            } else actor.discard.push(discarded);
        }
        playedInstances.add(card);
        actor.played[type] = (actor.played[type] ?? 0) + 1;
        if (effect.stopDraw) actor.stopDraw = true;
        if (effect.exhaust) exhaust(card);
        card.discount = (card.discount ?? 0) + (effect.discountAfterPlay ?? 0);
        if (doubleBlock) actor.block += actor.block - blockBefore;
        doubleBlock ||= Boolean(effect.doubleBlock);
        if (effect.returnToTop) actor.deck.push(card);
        else if (type !== "Power" && !effect.exhaust) actor.discard.push(card);
    }
    for (const card of hand.splice(0)) {
        const effect = duelEffect(card.id);
        delete card.sly;
        if (effect.retain || (retainHand && !effect.ethereal)) actor.retained.push(card);
        else if (effect.ethereal) {
            actor.exhausted++;
            actor.block += actor.blockOnExhaust;
        } else actor.discard.push(card);
        if (effect.endHandDamage) {
            const blocked = Math.min(actor.block, effect.endHandDamage);
            actor.block -= blocked;
            actor.hp = Math.max(0, actor.hp - (effect.endHandDamage - blocked));
        }
    }
    actor.block += actor.plating ?? 0;
    const triggered = actor.orbs.filter((orb) => orb.kind !== "plasma");
    for (const orb of triggered) duelOrb(actor, hits, orb, false);
    if (actor.hailstorm && actor.orbs.some((orb) => orb.kind === "frost")) {
        hits.push({ base: actor.hailstorm, attack: false });
    }
    return { cards: names, openingDraw, extraDraw, hits, triggered: triggered.map((orb) => orb.kind), conditionalWeak, block: actor.block };
}

const DUEL_STALEMATE_ROUNDS = 20;
const DUEL_REPORT_EDGE_ROUNDS = 6;
const renderReport = promisify(execFile);
const reportRenderer = fileURLToPath(new URL("./render_duel_report.py", import.meta.url));
let activeReportRenders = 0;

function simulateDuel(firstPlayer, secondPlayer, random) {
    const fighters = [duelFighter(firstPlayer, random), duelFighter(secondPlayer, random)];
    const startingHp = fighters.map((fighter) => fighter.hp);
    const turns = [];
    let idleRounds = 0;
    for (let round = 1; fighters.every((fighter) => fighter.hp > 0) && idleRounds < DUEL_STALEMATE_ROUNDS; round++) {
        const before = fighters.map((fighter) => fighter.hp);
        fighters[0].poison += fighters[1].poisonPerRound;
        fighters[1].poison += fighters[0].poisonPerRound;
        fighters[0].doom += fighters[1].doomPerRound;
        fighters[1].doom += fighters[0].doomPerRound;
        const intents = fighters.map((actor, side) => duelTurn(actor, fighters[1 - side], round, random));
        for (const [side, intent] of intents.entries()) {
            const target = fighters[1 - side];
            intent.weakApplied = target.played.Attack ? intent.conditionalWeak : 0;
            target.weak += intent.weakApplied;
        }
        // Both sides have finished preparing block and hits before either takes damage.
        for (const [side, intent] of intents.entries()) {
            const actor = fighters[side];
            const target = fighters[1 - side];
            intent.damage = 0;
            const retaliation = intent.hits.filter((hit) => hit.attack).length * (target.thorns ?? 0);
            if (retaliation) duelDamage(target, actor, { base: retaliation, attack: false });
            intent.blocked = 0;
            for (const hit of intent.hits) {
                const result = duelDamage(actor, target, hit);
                if (hit.doomOnHit) target.doom += result.damage;
                intent.damage += result.damage;
                intent.blocked += result.blocked;
            }
        }
        const status = fighters.map((fighter, side) => {
            let poison = 0;
            for (let tick = 0; tick <= (fighters[1 - side].extraPoisonTicks ?? 0) && fighter.poison && fighter.hp; tick++) {
                const loss = Math.min(fighter.hp, fighter.poison);
                poison += loss;
                fighter.hp -= loss;
                fighter.poison--;
            }
            const doom = fighter.hp > 0 && fighter.doom >= fighter.hp;
            if (doom) fighter.hp = 0;
            return { poison, doom, doomStacks: fighter.doom };
        });
        for (const fighter of fighters) {
            fighter.strength -= fighter.permanentEnemyStrengthLoss;
            fighter.enemyStrengthLoss = 0;
            fighter.permanentEnemyStrengthLoss = 0;
            fighter.weak = Math.max(0, fighter.weak - 1);
            fighter.vulnerable = Math.max(0, fighter.vulnerable - 1);
        }
        const hp = fighters.map((fighter) => fighter.hp);
        idleRounds = hp.every((value, side) => value === before[side]) ? idleRounds + 1 : 0;
        turns.push({ round, intents, status, hp });
    }
    return {
        hp: fighters.map((fighter) => fighter.hp), startingHp, turns,
        stalemate: idleRounds === DUEL_STALEMATE_ROUNDS,
    };
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

const ANCIENT_CARDS = new Set([
    "Break", "Corruption", "Suppress", "WraithForm", "MeteorShower", "TheSealedThrone",
    "ForbiddenGrimoire", "Protector", "BiasedCognition", "Quadcast",
]);

function loadPlayers() {
    try {
        const obj = JSON.parse(readFileSync(PLAYER_FILE, "utf8"));
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
        if (removeAncientCards(obj)) savePlayers(obj);
        return obj;
    } catch {
        return {};
    }
}

function removeAncientCards(store) {
    let changed = false;
    for (const player of Object.values(store)) {
        if (!player || typeof player !== "object") continue;
        for (const progress of [player, ...Object.values(player.jobDecks ?? {})]) {
            if (!progress) continue;
            for (const field of ["deck", "previousDeck", "previousJobDeck"]) {
                if (!Array.isArray(progress[field]) || !progress[field].some((id) => ANCIENT_CARDS.has(id.replace(/\+$/, "")))) continue;
                progress[field] = progress[field].filter((id) => !ANCIENT_CARDS.has(id.replace(/\+$/, "")));
                changed = true;
            }
            if (progress.offer?.cards?.some((id) => ANCIENT_CARDS.has(id))) {
                progress.offer.cards = progress.offer.cards.filter((id) => !ANCIENT_CARDS.has(id));
                changed = true;
            }
        }
    }
    return changed;
}
function savePlayers(obj) {
    try {
        const staged = `${PLAYER_FILE}.tmp`;
        writeFileSync(staged, JSON.stringify(obj), { encoding: "utf8", mode: 0o600 });
        renameSync(staged, PLAYER_FILE);
        return true;
    } catch {
        return false;
    }
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
    if (!p.jobDecks) {
        p.jobDecks = {};
        // The old one-time switch could only have left behind the default Defect deck.
        if (p.job !== "Defect" && Array.isArray(p.previousJobDeck) && p.previousJobDeck.length
            && p.previousJobDeck.every((id) => JOBS.Defect.starter.includes(id) || JOBS.Defect.pool.includes(id))) {
            p.jobDecks.Defect = { ...starterProgress("Defect"), deck: p.previousJobDeck.slice() };
        }
    }
    if (!p.lastDrawByJob) {
        p.lastDrawByJob = {};
        for (const job of Object.keys(JOBS)) {
            const offer = job === p.job ? p.offer : p.jobDecks[job]?.offer;
            if (Number.isFinite(offer?.ts)) p.lastDrawByJob[job] = today(new Date(offer.ts));
        }
    }
    return p;
}

function starterProgress(job) {
    return { deck: JOBS[job].starter.slice(), removePrice: REMOVE_BASE, offer: null };
}
function deckSummary(deck) {
    const m = new Map();
    for (const c of deck) m.set(c, (m.get(c) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
function offerLine(id, index) {
    const [name, energy, type, effect, stars] = GAME_CARDS[id];
    const energyText = energy < 0 ? "X" : energy;
    const starText = stars < 0 ? "X" : stars;
    const cost = stars ? `${energyText} 能量 + ${starText} 星星` : `${energyText} 能量`;
    return `${index + 1}. ${name}（${cost} · ${type === "Attack" ? "攻击" : type === "Power" ? "能力" : "技能"}）${effect}`;
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
    "/职业 [职业名] —— 查看或切换职业，各职业保留独立牌组",
    "/重置牌组 职业名 确认 —— 恢复该职业的初始牌组",
    "/抽卡 —— 每个职业每天一次，从当前职业卡池抽至多三张",
    "/升级 [序号] —— 每个职业每天升级一张牌",
    "/删卡 —— 花金币删一张牌（75 起，每删一次 +25）",
    "/遗物 —— 查看职业初始遗物",
    "/参战 [关闭] —— 开关本群被挑战权限",
    "/对战 @群友 —— 自动交锋，直到一方生命归零",
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
    "叫「鸡煲」会应你；其余按读空气规则参与闲聊",
].join("\n");

const CLOCK_FILE = join(DATA_DIR, "daily-clock.json");
const CLOCK_DATE = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "numeric", day: "numeric",
    weekday: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const CLOCK_LINES = [
    "愿今天也有一点值得收藏的小事。",
    "新的一天，先给自己留一点充电时间。",
    "昨天的进度已存档，今天可以慢慢来。",
    "夜色交班了。愿醒来时，手里刚好有一张好牌。",
    "新的回合开始。愿你遇到有趣的事，也有余力享受它。",
    "核心温度正常。祝今天的计划顺利，意外也有趣。",
    "愿今天有好消息，也有安静喝一杯水的时间。",
];

function clockInfo(now = new Date()) {
    const parts = Object.fromEntries(CLOCK_DATE.formatToParts(now).map(({ type, value }) => [type, value]));
    const date = `${parts.year}年${parts.month}月${parts.day}日`;
    const minute = `${parts.hour}:${parts.minute}`;
    const line = CLOCK_LINES[Math.floor((now.getTime() + 8 * 3600000) / 86400000) % CLOCK_LINES.length];
    return { date, minute, message: `【鸡煲报时】北京时间 ${minute}\n今天是 ${date}，${parts.weekday}。\n\n${line}` };
}

function loadClockGroups() {
    try {
        return JSON.parse(readFileSync(CLOCK_FILE, "utf8"));
    } catch (error) {
        if (error.code === "ENOENT") return {};
        throw error;
    }
}

function saveClockGroups(groups) {
    const staged = `${CLOCK_FILE}.tmp`;
    writeFileSync(staged, JSON.stringify(groups), { encoding: "utf8", mode: 0o600 });
    renameSync(staged, CLOCK_FILE);
}

export function startDailyClock(bot, logger) {
    let running = false;
    const timer = setInterval(async () => {
        const { date, minute, message } = clockInfo();
        if (running || minute !== "00:00") return;
        running = true;
        try {
            for (const group of Object.keys(loadClockGroups())) {
                const groups = loadClockGroups();
                if (!groups[group]?.enabled || groups[group].lastDate === date) continue;
                // Save before sending so a restart or ambiguous network error cannot repeat the greeting.
                groups[group].lastDate = date;
                groups[group].lastResult = "发送中或结果未知";
                saveClockGroups(groups);
                let result;
                try {
                    await bot.sendText({ scope: "group", targetId: group }, message);
                    result = "QQ API 已受理";
                } catch (error) {
                    result = `发送失败（错误码 ${error?.bizCode ?? error?.httpStatus ?? "未知"}）`;
                }
                const latest = loadClockGroups();
                if (latest[group]?.lastDate === date) {
                    latest[group].lastResult = result;
                    saveClockGroups(latest);
                }
                console.info(`[daily-clock] ${date} ${result}`);
            }
        } catch {
            logger?.warn?.("[daily-clock] could not read or save schedule");
        } finally {
            running = false;
        }
    }, 10000);
    timer.unref();
}

const HELP_ADMIN = [
    "/迎新 开启｜关闭 —— 管理本群入群欢迎",
    "/报时 开启｜关闭｜试发｜状态 —— 管理本群每天零点报时",
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
            name: ["升级"],
            category: "toys",
            scope: "all",
            description: "每天每职业升级一张牌，例：/升级 3",
            handler(ctx) {
                const store = loadPlayers();
                const player = getPlayer(store, uid(ctx));
                const raw = String(ctx.command?.raw ?? "").trim();
                if (!raw) return [
                    `【升级】${JOBS[player.job].name}｜每天一次，回复 /升级 序号`,
                    ...player.deck.map((id, index) => offerLine(id, index)),
                ].join("\n");
                if (!/^\d+$/.test(raw)) return "用法：/升级 序号";
                const index = Number(raw) - 1;
                if (index < 0 || index >= player.deck.length) return "请先发 /升级 查看牌组序号。";
                const id = player.deck[index];
                if (id.endsWith("+")) return "这张牌已经升级过了。";
                if (!GAME_CARDS[id + "+"]) return "这张牌暂未接入升级效果，请选择其他牌。";
                const day = today();
                player.lastUpgradeByJob ??= {};
                if (player.lastUpgradeByJob[player.job] === day) return "这个职业今天已经升级过了，明天再来。";
                player.deck[index] = id + "+";
                player.lastUpgradeByJob[player.job] = day;
                if (!savePlayers(store)) return "升级保存失败，请重试。";
                return offerLine(id + "+", index);
            },
        },
        {
            name: ["迎新"],
            category: "toys",
            scope: "group",
            description: "管理本群入群欢迎",
            handler(ctx) {
                const group = duelGroup(ctx);
                if (!group || !isAdmin(ctx, ctx.log)) return "请由机器人管理员在目标群操作。";
                const action = String(ctx.command?.raw ?? "").trim();
                if (!["开启", "关闭"].includes(action)) return "用法：/迎新 开启 或 /迎新 关闭。";
                const path = join(DATA_DIR, "welcome-groups.json");
                try {
                    let groups = [];
                    try {
                        groups = JSON.parse(readFileSync(path, "utf8"));
                    } catch (error) {
                        if (error.code !== "ENOENT") throw error;
                    }
                    const next = groups.filter((id) => id !== group);
                    if (action === "开启") next.push(group);
                    writeFileSync(path + ".tmp", JSON.stringify(next), { encoding: "utf8", mode: 0o600 });
                    renameSync(path + ".tmp", path);
                    return `本群入群欢迎已${action}。`;
                } catch {
                    return "保存迎新设置失败，请稍后重试。";
                }
            },
        },
        {
            name: ["报时"],
            category: "toys",
            scope: "group",
            description: "查看时间或管理本群零点报时",
            async handler(ctx) {
                const action = String(ctx.command?.raw ?? "").trim();
                const { message } = clockInfo();
                if (!action) return message;
                if (!isAdmin(ctx, ctx.log)) return "只有机器人管理员可以管理零点报时。";
                const group = duelGroup(ctx);
                if (!group) return "请在需要报时的群里使用。";
                if (action === "状态") {
                    try {
                        const settings = loadClockGroups()[group];
                        const last = settings?.lastDate
                            ? `\n最近一次：${settings.lastDate}｜${settings.lastResult ?? "旧版未记录发送结果"}`
                            : "";
                        return `本群零点报时${settings?.enabled ? "已开启" : "已关闭"}。${last}`;
                    } catch {
                        return "读取本群报时设置失败，请稍后重试。";
                    }
                }
                if (action === "试发") {
                    try {
                        await ctx.bot.sendText({ scope: "group", targetId: group }, message);
                        return;
                    } catch (error) {
                        const code = error?.bizCode ?? error?.httpStatus;
                        return `主动报时试发失败${code ? `（QQ 错误码 ${code}）` : ""}。`;
                    }
                }
                if (action !== "开启" && action !== "关闭") return "用法：/报时 开启、关闭、试发或状态。";
                try {
                    const groups = loadClockGroups();
                    groups[group] = { ...groups[group], enabled: action === "开启" };
                    saveClockGroups(groups);
                } catch {
                    return "保存本群报时设置失败，请稍后重试。";
                }
                return action === "开启" ? "已开启本群报时，每天北京时间 00:00 发送。" : "已关闭本群报时。";
            },
        },
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
            description: "查看或自由切换职业",
            handler: (ctx) => {
                const store = loadPlayers();
                const p = getPlayer(store, uid(ctx));
                const raw = String(ctx?.command?.raw ?? "").trim();
                const current = JOBS[p.job].name;
                const choices = Object.values(JOBS).map((job) => job.name).join("、");
                if (!raw) return `【职业】当前：${current}。可选：${choices}。输入 /职业 职业名 切换，各职业牌组独立保存。`;
                const chosen = Object.keys(JOBS).find((id) => JOBS[id].name === raw);
                if (!chosen) return `可选职业：${choices}。`;
                if (chosen === p.job) return `【职业】当前已是${current}。`;
                p.jobDecks[p.job] = { deck: p.deck, removePrice: p.removePrice, offer: p.offer };
                const progress = p.jobDecks[chosen] ?? starterProgress(chosen);
                delete p.jobDecks[chosen];
                Object.assign(p, progress, { job: chosen });
                if (!savePlayers(store)) return "职业切换保存失败，请重试。";
                return `【职业】已切换到${raw}｜牌组 ${p.deck.length} 张｜初始遗物：${JOBS[chosen].relic}`;
            },
        },
        {
            name: ["重置牌组"],
            category: "toys",
            scope: "all",
            description: "恢复指定职业的初始牌组",
            handler(ctx) {
                const store = loadPlayers();
                const player = getPlayer(store, uid(ctx));
                const [name, confirmation, ...extra] = String(ctx.command?.raw ?? "").trim().split(/\s+/);
                const job = name ? Object.keys(JOBS).find((id) => JOBS[id].name === name) : player.job;
                if (!job || extra.length || (confirmation && confirmation !== "确认")) {
                    return "用法：/重置牌组 职业名 确认";
                }
                if (!confirmation) {
                    return `将恢复${JOBS[job].name}的初始牌组和删卡价格，并清除该职业的待选卡。确认请发 /重置牌组 ${JOBS[job].name} 确认。`;
                }
                const progress = starterProgress(job);
                if (job === player.job) Object.assign(player, progress);
                else player.jobDecks[job] = progress;
                if (!savePlayers(store)) return "牌组重置保存失败，请重试。";
                return `【牌组】${JOBS[job].name}已恢复初始牌组（${progress.deck.length} 张）。`;
            },
        },
        {
            name: ["牌组", "deck", "我的牌组", "看牌组"],
            category: "toys",
            scope: "all",
            description: "查看当前牌组和金币",
            handler: async (ctx) => {
                const store = loadPlayers();
                const p = getPlayer(store, uid(ctx));
                const raw = String(ctx.command?.raw ?? "").trim();
                if (raw && !/^[1-9]\d*$/.test(raw)) return "用法：/牌组 或 /牌组 页码";
                const page = raw ? Number(raw) : 1;
                const pages = Math.ceil(p.deck.length / 25);
                if (!Number.isSafeInteger(page) || page > pages) return `牌组共有 ${pages} 页，请使用 /牌组 1～${pages}。`;
                const lines = [`【牌组】${who(ctx)}　${JOBS[p.job].name} · 共 ${p.deck.length} 张 · 金币 ${p.gold}`];
                for (const [c, n] of deckSummary(p.deck)) lines.push(`· ${GAME_CARDS[c][0]} ×${n}`);
                lines.push(`删一张牌 ${p.removePrice} 金币（发 /删卡 看序号）`);
                const offset = (page - 1) * 25;
                return await sendDeckPage(ctx, p.deck.slice(offset, offset + 25), lines[0] + `\n删卡价格：${p.removePrice} 金币`, lines.join("\n"), offset + 1, page, pages);
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
            handler: async (ctx) => {
                const store = loadPlayers();
                const id = uid(ctx);
                const p = getPlayer(store, id);
                const raw = String(ctx?.command?.raw ?? "").trim();
                const offer = p.offer;
                const pool = JOBS[p.job].pool.filter((id) => !ANCIENT_CARDS.has(id));
                const fresh = Boolean(
                    offer && Array.isArray(offer.cards) && offer.cards.length && offer.cards.every((id) => pool.includes(id)) && Date.now() - (offer.ts || 0) < OFFER_TTL_MS
                );

                if (!raw) {
                    if (fresh) {
                        const left = Math.max(1, Math.ceil((OFFER_TTL_MS - (Date.now() - offer.ts)) / 60000));
                        const text = [
                            `【抽卡】你有一组待选（还剩约 ${left} 分钟）：`,
                            ...offer.cards.map(offerLine),
                            `回复 /抽卡 序号（1～${offer.cards.length}），或 /抽卡 跳过`,
                        ].join("\n");
                        return await sendCardOffer(ctx, offer.cards, `【抽卡】待选卡牌｜还剩约 ${left} 分钟`, text);
                    }
                    const now = Date.now();
                    const day = today(new Date(now));
                    if (p.lastDrawByJob[p.job] === day) return "这个职业今天已经抽过卡了，明天再来。";
                    const r = rng(`offer|${id}|${now}|${Math.random()}`);
                    const cards = sample(r, pool, OFFER_SIZE);
                    p.offer = { cards, ts: now };
                    p.lastDrawByJob[p.job] = day;
                    if (!savePlayers(store)) return "抽卡保存失败，请重试。";
                    const text = [
                        `【抽卡】${JOBS[p.job].name}｜${cards.length} 张可选`,
                        ...cards.map(offerLine),
                        `回复 /抽卡 序号（1～${cards.length}），或 /抽卡 跳过`,
                    ].join("\n");
                    return await sendCardOffer(ctx, cards, `【抽卡】${JOBS[p.job].name}｜${cards.length} 张可选`, text);
                }
                if (raw === "跳过" || raw.toLowerCase() === "skip") {
                    if (!fresh) return "现在没有待选的牌。";
                    p.offer = null;
                    if (!savePlayers(store)) return "抽卡保存失败，请重试。";
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
                if (!savePlayers(store)) return "抽卡保存失败，请重试。";
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
            description: "@本群成员发起对战",
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
                const names = [who(ctx), other.duelGroups?.[groupKey] || "被挑战者"].map((name) =>
                    String(name).replace(/[\r\n]/g, " ").slice(0, 30));
                if (nativeDuelEnabled()) {
                    return await sendNativeDuel(ctx, [player, first].map(p => ({ job: p.job, deck: p.deck.slice() })), names);
                }
                if ([player, first].some(p => p.deck.some(card => !Object.hasOwn(DUEL_EFFECTS, card) || GAME_CARDS[card][4] < 0))) {
                    return "当前原版对战引擎未启用，新卡牌无法使用旧引擎结算，请稍后再试。";
                }
                const { hp, startingHp, turns, stalemate } = simulateDuel(player, first, Math.random);
                const result = stalemate ? "僵局，判平"
                    : hp[0] === hp[1] ? "平局" : `${names[hp[0] > hp[1] ? 0 : 1]}获胜`;
                const omitted = Math.max(0, turns.length - 2 * DUEL_REPORT_EDGE_ROUNDS);
                const displayed = omitted
                    ? [...turns.slice(0, DUEL_REPORT_EDGE_ROUNDS), ...turns.slice(-DUEL_REPORT_EDGE_ROUNDS)]
                    : turns;
                const report = displayed.flatMap(({ round, intents, status, hp: roundHp }, index) => {
                    const plays = intents.map((intent, side) => {
                        const label = side === 0 ? "先手" : "后手";
                        const cards = intent.cards.slice(0, 12).join(" → ") || "无出牌";
                        const extra = intent.cards.length > 12 ? ` 等${intent.cards.length}张` : "";
                        const opening = intent.openingDraw.join("、") || "无";
                        const extraDraw = intent.extraDraw.slice(0, 12).join("、");
                        const extraCount = intent.extraDraw.length > 12 ? ` 等${intent.extraDraw.length}张` : "";
                        const bonus = extraDraw ? `｜额外抽牌：${extraDraw}${extraCount}` : "";
                        const orbs = ["lightning", "frost", "dark", "glass"].map((orb) => intent.triggered.filter((value) => value === orb).length);
                        const triggers = orbs.map((count, index) => count ? `${count}个${["电球", "冰球", "黑暗球", "玻璃球"][index]}` : "")
                            .filter(Boolean).join("、");
                        const orbText = triggers ? `｜触发${triggers}` : "";
                        const weak = intent.weakApplied ? `｜眼部攻击施加${intent.weakApplied}层虚弱` : "";
                        const blocked = intent.blocked ? `（${intent.blocked}点被格挡）` : "";
                        return [
                            `   ${label}抽牌：${opening}${bonus}`,
                            `   ${label}出牌：${cards}${extra}${orbText}${weak}`,
                            `   ${label}意图：${intent.damage}点伤害${blocked} · ${intent.block}点格挡`,
                        ].join("\n");
                    });
                    const statuses = status.flatMap(({ poison, doom, doomStacks }, side) => {
                        const label = side === 0 ? "先手" : "后手";
                        return [poison ? `${label}中毒扣${poison}` : "", doom ? `${label}灾厄处决`
                            : doomStacks ? `${label}灾厄${doomStacks}` : ""].filter(Boolean);
                    });
                    const statusText = statuses.length ? `｜${statuses.join(" · ")}` : "";
                    const lines = [`第${round}轮`, ...plays, `   同时结算${statusText}｜HP ${roundHp.join(":")}`];
                    if (omitted && index === DUEL_REPORT_EDGE_ROUNDS) lines.unshift(`……中间 ${omitted} 轮略……`);
                    return lines;
                });
                if (stalemate) report.push(`双方连续 ${DUEL_STALEMATE_ROUNDS} 轮生命无变化。`);
                const title = `【交锋对战】${names[0]}（先手） vs ${names[1]}（后手）`;
                report.unshift(`初始生命｜HP ${startingHp.join(":")}`);
                const score = `${hp.join(":")}｜${result}｜共 ${turns.length} 轮`;
                const summary = `${title}\n${score}`;
                const reportText = [title, ...report, `【结算】${score}`].join("\n");
                if (activeReportRenders >= 2) return reportText;
                activeReportRenders++;
                try {
                    const { stdout } = await renderReport("python3", [reportRenderer, reportText], {
                        encoding: "buffer", timeout: 10000, maxBuffer: 4 * 1024 * 1024,
                    });
                    await ctx.bot.sendImage(ctx.replyTarget, { buffer: stdout }, { content: summary });
                    return;
                } catch (error) {
                    ctx.log?.warn?.(`[toys] report image failed: ${error?.bizCode ?? error?.code ?? "unknown"}`);
                    return reportText;
                } finally {
                    activeReportRenders--;
                }
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
