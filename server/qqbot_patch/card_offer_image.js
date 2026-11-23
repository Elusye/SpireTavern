import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const execute = promisify(execFile);
const renderer = fileURLToPath(new URL('./render_card_offer.py', import.meta.url));
let active = 0;

export async function sendCardOffer(ctx, cards, heading, fallback) {
    return sendCards(ctx, cards, `${heading}\n按图片从左到右选择，回复 /抽卡 序号（1～${cards.length}），或 /抽卡 跳过`, fallback);
}

export async function sendDeckPage(ctx, cards, heading, fallback, start, page, pages) {
    const next = page < pages ? `\n下一页：/牌组 ${page + 1}` : '';
    return sendCards(ctx, cards, `${heading}\n第 ${page}/${pages} 页｜序号对应 /删卡 和 /升级${next}`, fallback, ['--deck', '--start', String(start)]);
}

async function sendCards(ctx, cards, content, fallback, extra = []) {
    if (!ctx.bot?.sendImage || active >= 2) return fallback;
    active++;
    try {
        const { stdout } = await execute(process.env.DSH_QQBOT_REPORT_PYTHON || 'python3',
            [renderer, '--cards', JSON.stringify(cards), ...extra],
            { encoding: 'buffer', timeout: 15000, maxBuffer: 12 * 1024 * 1024 });
        await ctx.bot.sendImage(ctx.replyTarget, { buffer: stdout }, {
            content,
        });
        return;
    } catch (error) {
        ctx.log?.warn?.(`[toys] card offer image failed: ${error?.bizCode ?? error?.code ?? 'unknown'}`);
        return fallback;
    } finally { active--; }
}
