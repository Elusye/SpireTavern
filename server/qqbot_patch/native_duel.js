import { connect } from "node:net";
import { readFileSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const renderer = fileURLToPath(new URL('./render_duel_report.py', import.meta.url));
function configuration() {
    try { return JSON.parse(readFileSync(new URL('./native_duel.config.json', import.meta.url), 'utf8')); }
    catch { return { enabled: false }; }
}
export function nativeDuelEnabled() { return configuration().enabled === true; }

export function requestNativeDuel(players) {
    const config = configuration();
    const socketPath = process.env.DSH_QQBOT_NATIVE_DUEL_SOCKET || config.socket || '/run/qqbot-duel-engine/engine.sock';
    return new Promise((resolve, reject) => {
        const socket = connect(socketPath);
        let data = '';
        let settled = false;
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            error ? reject(error) : resolve(value);
        };
        socket.setTimeout(110000, () => finish(new Error('engine timeout')));
        socket.on('connect', () => socket.write(JSON.stringify({ seed: randomUUID().replaceAll('-', ''), players }) + '\n'));
        socket.on('error', error => finish(error));
        socket.on('end', () => { if (!settled) finish(new Error('engine connection closed')); });
        socket.on('data', chunk => {
            data += chunk.toString('utf8');
            if (Buffer.byteLength(data) > 3 * 1024 * 1024) return finish(new Error('engine response too large'));
            const end = data.indexOf('\n');
            if (end < 0) return;
            try { finish(null, JSON.parse(data.slice(0, end))); }
            catch (error) { finish(error); }
        });
    });
}

export async function sendNativeDuel(ctx, players, names) {
    try {
        const response = await requestNativeDuel(players);
        if (!response.ok) {
            if (response.error === 'busy') return '当前有一场对战正在进行，请稍后再试。';
            ctx.log?.warn?.(`[toys] native duel failed: ${response.error || 'unknown'} run=${response.run || '-'}`);
            return '本场对战未能完成，未改动双方牌组。请稍后重试。';
        }
        const record = response.record;
        if (record?.gameVersion !== '0.111.1' || record?.mode !== 'alternating_immediate') throw new Error('Invalid engine version');
        const hp = new Map(record.turns.at(-1).after.map(player => [player.id, player.hp]));
        const alive = [1, 2].filter(id => hp.get(id) > 0);
        if (alive.length > 1 || alive.some(id => !record.winner.includes(id)) || record.winner.length !== alive.length) throw new Error('Invalid engine winner');
        const winner = record.winner.length ? `${names[record.winner[0] - 1]}获胜` : '双方倒下，平局';
        const summary = `【轮流对战】${names[0]} vs ${names[1]}\n先手：${names[record.first - 1]}｜${hp.get(1)}:${hp.get(2)}｜${winner}｜共${record.turns.length}回合`;
        const directory = mkdtempSync(join(tmpdir(), 'qqbot-native-report-'));
        const recordFile = join(directory, 'record.json');
        const nameFile = join(directory, 'names.json');
        try {
            writeFileSync(recordFile, JSON.stringify(record));
            writeFileSync(nameFile, JSON.stringify({ 1: names[0], 2: names[1] }));
            const { stdout } = await execute(process.env.DSH_QQBOT_REPORT_PYTHON || 'python3', [renderer, '--json', recordFile, '--players', nameFile], {
                encoding: 'buffer', timeout: 15000, maxBuffer: 12 * 1024 * 1024,
            });
            await ctx.bot.sendImage(ctx.replyTarget, { buffer: stdout }, { content: summary });
            return;
        } catch (error) {
            ctx.log?.warn?.(`[toys] native report failed: ${error?.bizCode ?? error?.code ?? 'unknown'}`);
            return summary + '\n详细战报图片发送失败。';
        } finally {
            for (const file of [recordFile, nameFile]) { try { unlinkSync(file); } catch {} }
            try { rmdirSync(directory); } catch {}
        }
    } catch (error) {
        ctx.log?.warn?.(`[toys] native engine unavailable: ${error?.code || error?.message || 'unknown'}`);
        return '对战引擎暂时不可用，未改动双方牌组，请稍后再试。';
    }
}
