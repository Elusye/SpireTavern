// Offline command-chain test: uses synthetic saves and captures images, never sends to QQ.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const directory = mkdtempSync(join(tmpdir(), 'qqbot-native-smoke-'));
process.env.DSH_QQBOT_TOYS_DIR = directory;
const { toysCommands } = await import('./lib/commands/toys.js');
const { requestNativeDuel } = await import('./lib/commands/native_duel.js');
const players = [
    {job:'Ironclad',deck:['StrikeIronclad+','StrikeIronclad','DefendIronclad+','Bash+','PommelStrike','Bloodletting','Rupture+','InfernalBlade+']},
    {job:'Defect',deck:['StrikeDefect+','StrikeDefect','DefendDefect+','Zap+','Dualcast+','ColdSnap','WhiteNoise+','EchoForm+']},
];
const store = {'native-smoke-A':{...players[0],gold:77},'native-smoke-B':{...players[1],gold:88}};
const storeFile=join(directory,'players.json');
writeFileSync(storeFile,JSON.stringify(store));
const upgradeCommand=toysCommands().find(c=>c.name.includes('升级'));
assert.ok(upgradeCommand,'Upgrade command is included in this release');
const upgradeContext=raw=>({message:{senderId:'native-smoke-A',senderName:'上线测试甲'},command:{name:'升级',args:[raw],raw},log:{warn:()=>{}}});
upgradeCommand.handler(upgradeContext('2'));
assert.equal(JSON.parse(readFileSync(storeFile,'utf8'))['native-smoke-A'].deck[1],'StrikeIronclad+');
const limited=upgradeCommand.handler(upgradeContext('5'));
assert.ok(String(limited).includes('今天已经升级'));
const before=readFileSync(storeFile,'utf8');
const game=requestNativeDuel(players);
await new Promise(resolve=>setTimeout(resolve,150));
const busy=await requestNativeDuel(players);
assert.equal(busy.error,'busy');
const response=await game;
assert.equal(response.ok,true,JSON.stringify(response));
assert.equal(response.record.deckMode,'saved');
assert.equal(response.record.initialDecks[0].hp,86);
assert.deepEqual(response.record.initialDecks.map(p=>p.cards),players.map(p=>p.deck));
assert.ok(response.record.turns.some(t=>t.draw.some(c=>c.endsWith('+'))));
writeFileSync(join(directory,'direct-record.json'),JSON.stringify(response.record,null,2));
const invalid=await requestNativeDuel([{job:'Ironclad',deck:['Neutralize']},players[1]]);
assert.equal(invalid.error,'invalid_request');
let sends=0;
const handler=toysCommands().find(c=>c.name.includes('对战')).handler;
const output=await handler({message:{senderId:'native-smoke-A',senderName:'上线测试甲',groupOpenid:'native-smoke-group',content:'/对战 <@native-smoke-B>'},
    command:{name:'对战',args:[],raw:''},replyTarget:{},log:{warn:message=>console.error(message)},
    bot:{sendImage:async(_target,{buffer},{content})=>{
        sends++;
        assert.equal(buffer.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
        assert.ok(content.includes('轮流对战')&&content.includes('上线测试甲'));
        writeFileSync(join(directory,'report.png'),buffer);
    }}});
assert.equal(output,undefined);
assert.equal(sends,1);
assert.equal(readFileSync(storeFile,'utf8'),before,'The battle must not rewrite saved decks or gold');
console.log(JSON.stringify({passed:true,directory,busy:true,upgradedSavedDecks:true,ironcladHp:86,images:sends,savesUnchanged:true}));
