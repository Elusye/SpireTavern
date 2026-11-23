import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {requestNativeDuel} from './lib/commands/native_duel.js';
const players=[{job:'Ironclad',deck:['Rupture+','InfernalBlade+','StrikeIronclad+']},
  {job:'Defect',deck:['WhiteNoise+','StrikeDefect+','Zap+']}];
const response=await requestNativeDuel(players);
assert.equal(response.ok,true,JSON.stringify(response));
assert.deepEqual(response.record.initialDecks.map(p=>p.cards),players.map(p=>p.deck));
const played=new Set(response.record.turns.flatMap(t=>t.plays.map(p=>p.card)));
for(const card of ['RUPTURE+','INFERNAL_BLADE+','WHITE_NOISE+'])assert.ok(played.has(card),card);
writeFileSync(new URL('./new-card-record.json',import.meta.url),JSON.stringify(response.record,null,2));
execFileSync('python3',[new URL('./lib/commands/render_duel_report.py',import.meta.url).pathname,
  '--json',new URL('./new-card-record.json',import.meta.url).pathname,
  '--output',new URL('./new-card-report.png',import.meta.url).pathname]);
console.log(JSON.stringify({passed:true,newCardsPlayed:[...played].filter(c=>['RUPTURE+','INFERNAL_BLADE+','WHITE_NOISE+'].includes(c)),
  modelHash:response.record.modelHash,seconds:response.seconds,turns:response.record.turns.length}));
