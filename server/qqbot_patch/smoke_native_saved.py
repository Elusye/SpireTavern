"""Read existing decks and test the engine without identifiers, save writes or QQ messages."""
import asyncio
import json
from pathlib import Path
import uuid

ROOT=Path('/root/qqbot-native-engine')
catalog=json.loads((ROOT/'legacy-card-pool.json').read_text())
store=json.loads(Path('/root/.dsh/profiles/qqbot/toys_data/players.json').read_text())
parties={}
archived=0
for player in store.values():
    job=player.get('job','Defect')
    if job in catalog and isinstance(player.get('deck'),list):
        if job not in parties or len(player['deck'])>len(parties[job]['deck']):
            parties[job]={'job':job,'deck':player['deck']}
    for job,progress in player.get('jobDecks',{}).items():
        if job not in catalog or not isinstance(progress,dict):continue
        allowed=set(catalog[job]['starter']+catalog[job]['pool'])
        assert all(c.removesuffix('+') in allowed for c in progress.get('deck',[])), 'Unsupported archived deck'
        archived+=1

async def call(players):
    reader,writer=await asyncio.open_unix_connection('/run/qqbot-duel-engine/engine.sock',limit=3*1024*1024)
    request={'seed':uuid.uuid4().hex,'players':players}
    writer.write(json.dumps(request).encode()+b'\n');await writer.drain()
    result=json.loads(await asyncio.wait_for(reader.readline(),100))
    writer.close();await writer.wait_closed()
    assert result['ok'], result
    record=result['record']
    assert [p['cards'] for p in record['initialDecks']]==[p['deck'] for p in players]
    assert [p['job'] for p in record['characters']]==[p['job'] for p in players]
    print(json.dumps({'jobs':[p['job'] for p in players],'sizes':[len(p['deck']) for p in players],
                      'turns':len(record['turns']),'run':result['run'],'passed':True}),flush=True)
    return result['run']

async def main():
    runs=[]
    for job in ['Ironclad','Silent']:
        if job in parties and 'Defect' in parties:runs.append(await call([parties[job],parties['Defect']]))
    other=[{'job':job,'deck':catalog[job]['starter']+[c+'+' for c in catalog[job]['pool'][:3]]} for job in ['Regent','Necrobinder']]
    runs.append(await call(other))
    (ROOT/'saved-deck-smoke.json').write_text(json.dumps({'passed':True,'archivedDecksChecked':archived,'runs':runs},indent=2))
    print(json.dumps({'passed':True,'archivedDecksChecked':archived,'matches':len(runs)}))

asyncio.run(main())
