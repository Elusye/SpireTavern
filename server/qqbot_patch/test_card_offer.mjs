// Synthetic saves and fake sendImage only; never sends a QQ message.
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const data=mkdtempSync(join(tmpdir(),'qqbot-card-offer-'));
process.env.DSH_QQBOT_TOYS_DIR=data;
const {toysCommands}=await import('./lib/commands/toys.js');
const handler=toysCommands().find(c=>c.name.includes('抽卡')).handler;
const now=new Date();const day=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
const file=join(data,'players.json');
writeFileSync(file,JSON.stringify({test:{job:'Silent',deck:['StrikeSilent'],gold:77,
 offer:{cards:['Finisher','Dash','Backflip'],ts:Date.now()},lastDrawByJob:{Silent:day}}}));
let images=0;let fail=false;
const context=(id,raw='')=>({message:{senderId:id,senderName:'测试'},command:{raw},replyTarget:{},log:{warn:()=>{}},
 bot:{sendImage:async(_target,{buffer},{content})=>{
  if(fail)throw new Error('test image failure');
  assert.equal(buffer.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  assert.ok(content.includes('/抽卡')&&content.includes('从左到右'));
  images++;writeFileSync(join(data,`offer-${images}.png`),buffer);
 }}});
assert.equal(await handler(context('test')),undefined);
const before=readFileSync(file,'utf8');
assert.equal(await handler(context('test')),undefined);
assert.equal(readFileSync(file,'utf8'),before,'Viewing must not reroll or save');
fail=true;
const text=await handler(context('test'));
assert.ok(text.includes('终结技')&&text.includes('冲刺'));
assert.equal(readFileSync(file,'utf8'),before,'Image failure must preserve pending offer');
fail=false;
assert.ok((await handler(context('test','2'))).includes('冲刺'));
let saved=JSON.parse(readFileSync(file,'utf8')).test;
assert.deepEqual(saved.deck,['StrikeSilent','Dash']);assert.equal(saved.offer,null);assert.equal(saved.gold,77);
assert.ok((await handler(context('test'))).includes('今天已经抽过卡'));
assert.equal(await handler(context('new')),undefined);
saved=JSON.parse(readFileSync(file,'utf8')).new;
assert.equal(saved.offer.cards.length,3);
const offered=saved.offer.cards.slice();
assert.equal(await handler(context('new')),undefined);
assert.deepEqual(JSON.parse(readFileSync(file,'utf8')).new.offer.cards,offered);
assert.ok((await handler(context('new','跳过'))).includes('已跳过'));
assert.ok((await handler(context('new'))).includes('今天已经抽过卡'));
console.log(JSON.stringify({passed:true,images,directory:data,pendingStable:true,selection:true,dailyLimit:true,textFallback:true}));
