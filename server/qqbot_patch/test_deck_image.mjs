import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const directory=mkdtempSync(join(tmpdir(),'qqbot-deck-image-'));
process.env.DSH_QQBOT_TOYS_DIR=directory;
const {toysCommands}=await import('./lib/commands/toys.js');
const handler=toysCommands().find(c=>c.name.includes('牌组')).handler;
const deck=[...Array(25).fill('StrikeIronclad'),'Bash+','StrikeIronclad+'];
const file=join(directory,'players.json');writeFileSync(file,JSON.stringify({test:{job:'Ironclad',deck,gold:123}}));
const before=readFileSync(file,'utf8');let count=0,fail=false;
const ctx=raw=>({message:{senderId:'test',senderName:'牌组测试'},command:{raw},replyTarget:{},log:{warn:()=>{}},
 bot:{sendImage:async(_target,{buffer},{content})=>{
  if(fail)throw new Error('test failure');count++;
  assert.equal(buffer.readUInt32BE(16),2000);
  assert.equal(buffer.readUInt32BE(20),count===1?2670:534);
  assert.ok(content.includes('第 '+count+'/2 页'));
  if(count===1)assert.ok(content.includes('/牌组 2'));
  writeFileSync(join(directory,`deck-${count}.png`),buffer);
 }}});
assert.equal(await handler(ctx('')),undefined);
assert.equal(await handler(ctx('2')),undefined);
assert.equal(readFileSync(file,'utf8'),before);
assert.ok((await handler(ctx('3'))).includes('共有 2 页'));
assert.ok((await handler(ctx('0'))).includes('用法'));
fail=true;const fallback=await handler(ctx('2'));
assert.ok(fallback.includes('痛击+')&&fallback.includes('×25'));
assert.equal(readFileSync(file,'utf8'),before);
console.log(JSON.stringify({passed:true,images:count,directory,columns:5,pageSize:25,upgradedCards:true,savesUnchanged:true,textFallback:true}));
