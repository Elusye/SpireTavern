// Runs the real handlers against synthetic local saves. No QQ connections.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=resolve(import.meta.dirname,'../..');
const stage=mkdtempSync(join(tmpdir(),'qqbot-expanded-'));
mkdirSync(join(stage,'commands'));mkdirSync(join(stage,'features'));mkdirSync(join(stage,'data'));
writeFileSync(join(stage,'package.json'),'{"type":"module"}');
const source=readFileSync(join(root,'server/qqbot_patch/toys.js'),'utf8');
writeFileSync(join(stage,'commands/toys.js'),source+'\nexport {JOBS,GAME_CARDS,ANCIENT_CARDS};\n');
copyFileSync(join(root,'server/qqbot_patch/native_duel.js'),join(stage,'commands/native_duel.js'));
copyFileSync(join(root,'server/qqbot_patch/card_offer_image.js'),join(stage,'commands/card_offer_image.js'));
copyFileSync(join(root,'server/qqbot_patch/admin-guard.js'),join(stage,'features/admin-guard.js'));
process.env.DSH_QQBOT_TOYS_DIR=join(stage,'data');
const {toysCommands,JOBS,GAME_CARDS,ANCIENT_CARDS}=await import(pathToFileURL(join(stage,'commands/toys.js')));
const commands=toysCommands();
const audit=JSON.parse(readFileSync(join(root,'local-game-validation/card-expansion-audit.json'),'utf8'));
const excluded=JSON.parse(readFileSync(join(root,'local-game-validation/card-expansion-policy.json'),'utf8')).excluded;
const store={};
for(const [job,data] of Object.entries(JOBS)) {
  assert.equal(data.pool.length,79);assert.equal(new Set(data.pool).size,79);
  for(const card of data.pool) {
    assert.ok(!ANCIENT_CARDS.has(card));assert.ok(GAME_CARDS[card]);assert.ok(GAME_CARDS[card+'+']);
    assert.ok(!GAME_CARDS[card][3].includes('res://'));
  }
  for(const card of audit[job].candidates) {
    if(card in excluded) {assert.ok(!data.pool.includes(card));continue;}
    store[job+'-'+card]={job,deck:[card],gold:77};
  }
}
const file=join(stage,'data/players.json');writeFileSync(file,JSON.stringify(store));
for(const id of Object.keys(store)) {
  const context={message:{senderId:id,senderName:'测试'},command:{raw:'1',args:['1']},log:{warn:()=>{}}};
  const reply=commands.find(c=>c.name.includes('升级')).handler(context);
  const saved=JSON.parse(readFileSync(file,'utf8'))[id];
  assert.equal(saved.deck[0],store[id].deck[0]+'+',String(reply));assert.equal(saved.gold,77);
  const limited=commands.find(c=>c.name.includes('升级')).handler({...context,command:{raw:'',args:[]}});
  assert.ok(String(limited).includes(GAME_CARDS[saved.deck[0]][0]));
}
const group='expanded-test';const groupKey=JSON.stringify(['group',group]);
store.a={job:'Ironclad',deck:['Juggernaut'],gold:77};store.b={job:'Defect',deck:['WhiteNoise'],gold:88};
writeFileSync(file,JSON.stringify(store));
const result=await commands.find(c=>c.name.includes('对战')).handler({
  message:{senderId:'a',senderName:'测试甲',groupOpenid:group,content:'/对战 <@b>'},command:{raw:'',args:[]},log:{warn:()=>{}}});
assert.ok(String(result).includes('原版对战引擎未启用'),String(result));
console.log(JSON.stringify({passed:true,pools:Object.fromEntries(Object.entries(JOBS).map(([job,data])=>[job,data.pool.length])),newCardUpgradeCommands:Object.keys(store).length-2,legacyFallbackBlocked:true}));
