"""Single-flight, local-only bridge to the original Linux game. Never reads bot credentials."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import time
import uuid

ROOT = Path(os.environ.get('QQBOT_ENGINE_ROOT', '/root/qqbot-native-engine/v0.111.1')).resolve()
SOCKET = Path(os.environ.get('QQBOT_ENGINE_SOCKET', '/run/qqbot-duel-engine/engine.sock'))
RUNS = ROOT.parent / 'runs'
CATALOG = json.loads((ROOT.parent / 'legacy-card-pool.json').read_text(encoding='utf-8'))
MODEL_HASH = hashlib.sha256((ROOT / 'mods/QQBotEnemyTest/QQBotEnemyTest.dll').read_bytes()).hexdigest()
busy = False
host_process = None
host_directory = None
host_signature = None
host_matches = 0
host_lock = asyncio.Lock()

def speed_profile():
    try:
        value = json.loads((ROOT.parent/'speed.json').read_text())
        return {'fps':min(240,max(30,int(value.get('fps',30)))),
                'scale':min(8,max(1,float(value.get('scale',1)))),
                'disableRender':value.get('disableRender') is True,'resident':value.get('resident') is True}
    except (OSError,ValueError,TypeError):
        return {'fps':30,'scale':1,'disableRender':False,'resident':False}

async def _stop_host():
    global host_process,host_directory,host_signature,host_matches
    if host_process and host_process.returncode is None:
        os.killpg(host_process.pid,signal.SIGTERM)
        try:await asyncio.wait_for(host_process.wait(),5)
        except asyncio.TimeoutError:
            os.killpg(host_process.pid,signal.SIGKILL);await host_process.wait()
    host_process=None;host_directory=None;host_signature=None;host_matches=0

async def _ensure_host(speed):
    global host_process,host_directory,host_signature
    signature=(speed['fps'],speed['scale'],speed['disableRender'])
    if host_process and host_process.returncode is None and host_signature==signature:
        old_log=(host_directory/'game.log').read_text(errors='replace')
        if not re.search(r'^(?:ERROR: |\[ERROR\] )System\.[A-Za-z.]*Exception:',old_log,re.M):return
    await _stop_host()
    host_directory=ROOT.parent/'hosts'/uuid.uuid4().hex
    settings=host_directory/'user/data/SlayTheSpire2/default/1/settings.save'
    settings.parent.mkdir(parents=True)
    settings.write_text(json.dumps({'schema_version':8,'volume_master':0,'volume_bgm':0,'volume_sfx':0,'volume_ambience':0,
        'skip_intro_logo':True,'seen_ea_disclaimer':True,'language':'eng','fps_limit':speed['fps'],
        'mod_settings':{'mods_enabled':True,'mod_list':[]}}))
    env=os.environ.copy()
    env.pop('QQBOT_DUEL_INPUT',None)
    env.update(HOME=str(host_directory/'user'),XDG_DATA_HOME=str(host_directory/'user/data'),XDG_CONFIG_HOME=str(host_directory/'user/config'),
        LD_LIBRARY_PATH=str(ROOT)+':'+str(ROOT/'data_sts2_linuxbsd_x86_64'),QQBOT_TEST_CASE='duel',QQBOT_TEST_MUTED='1',
        QQBOT_RESOURCE_VARIANT='lean',QQBOT_RESIDENT_DIR=str(host_directory),QQBOT_RUNS_ROOT=str(RUNS),QQBOT_DUEL_ORDER='random')
    with (host_directory/'console.txt').open('wb') as log:
        host_process=await asyncio.create_subprocess_exec(str(ROOT/'SlayTheSpire2'),'--headless','--audio-driver','Dummy',
            '--force-steam=off','--qqbot-test-enemy','--log-file',str(host_directory/'game.log'),'--time-scale',str(speed['scale']),
            cwd=ROOT,env=env,stdin=asyncio.subprocess.DEVNULL,stdout=log,stderr=asyncio.subprocess.STDOUT,start_new_session=True)
    host_signature=signature
    for attempt in range(900):
        if host_process.returncode is not None:raise RuntimeError('resident startup exited')
        ready=host_directory/'ready.json'
        if ready.exists():
            assert json.loads(ready.read_text())['modelHash']==MODEL_HASH
            print(json.dumps({'event':'resident_ready','host':host_directory.name}),flush=True)
            return
        await asyncio.sleep(.05)
    await _stop_host();raise TimeoutError('resident startup')

async def stop_host():
    async with host_lock:
        await _stop_host()

async def ensure_host(speed):
    async with host_lock:
        await _ensure_host(speed)

async def prewarm():
    while True:
        await asyncio.sleep(1)
        if not busy:
            speed=speed_profile()
            if speed['resident']:
                try:await ensure_host(speed)
                except Exception as error:
                    print(json.dumps({'event':'prewarm_failed','type':type(error).__name__}),flush=True)
                    await asyncio.sleep(2)

async def run_resident(request,speed):
    global host_matches
    started=time.monotonic()
    await ensure_host(speed)
    run=RUNS/uuid.uuid4().hex
    run.mkdir(parents=True,mode=0o700)
    (run/'input.json').write_text(json.dumps(request))
    (run/'speed.json').write_text(json.dumps(speed))
    (run/'host.json').write_text(json.dumps({'host':str(host_directory)}))
    log_path=host_directory/'game.log'
    offset=log_path.stat().st_size
    pending=host_directory/'request.json'
    pending.with_suffix('.tmp').write_text(json.dumps({'run':run.name}))
    pending.with_suffix('.tmp').replace(pending)
    done_path=host_directory/('done-'+run.name+'.json')
    try:
        for attempt in range(1800):
            if host_process.returncode is not None:raise RuntimeError('resident exited')
            if done_path.exists():break
            await asyncio.sleep(.05)
        else:raise TimeoutError('resident match')
        done=json.loads(done_path.read_text())
        with log_path.open('rb') as source:source.seek(offset);log=source.read().decode(errors='replace')
        (run/'game.log').write_text(log)
        result=json.loads((run/'result.json').read_text())
        record=json.loads((run/'alternating-duel.json').read_text())
        valid=done['passed'] and result['passed'] and result['modelHash']==MODEL_HASH
        valid=valid and not re.search(r'^(?:ERROR: |\[ERROR\] )System\.[A-Za-z.]*Exception:',log,re.M)
        alive=[p['id'] for p in record['turns'][-1]['after'] if p['hp']>0]
        valid=valid and len(alive)<=1 and set(alive)==set(record['winner'])
        host_matches+=1
        seconds=round(time.monotonic()-started,3)
        (run/'resident-result.json').write_text(json.dumps({**done,'secondsWithStartup':seconds,'match':host_matches}))
        print(json.dumps({'event':'resident_completed','run':run.name,'seconds':seconds,'workingMiB':round(done['workingBytes']/1048576,1),'match':host_matches}),flush=True)
        if not valid:
            await stop_host();return {'ok':False,'error':'resident_failed','run':run.name}
        if host_matches>=20 or done['workingBytes']>=720*1048576:
            await stop_host()
        return {'ok':True,'run':run.name,'seconds':seconds,'record':record}
    except Exception:
        await stop_host()
        raise


def validate(request):
    if not isinstance(request, dict) or not re.fullmatch(r'[A-Za-z0-9]{1,64}', request.get('seed', '')):
        raise ValueError('seed')
    players = request.get('players')
    if not isinstance(players, list) or len(players) != 2:
        raise ValueError('players')
    for player in players:
        if not isinstance(player, dict) or player.get('job') not in CATALOG:
            raise ValueError('job')
        allowed = set(CATALOG[player['job']]['starter'] + CATALOG[player['job']]['pool'])
        deck = player.get('deck')
        if not isinstance(deck, list) or not 1 <= len(deck) <= 300:
            raise ValueError('deck')
        if any(not isinstance(card, str) or card.removesuffix('+') not in allowed for card in deck):
            raise ValueError('card')
    return {'seed': request['seed'], 'players': [{'job':p['job'], 'deck':p['deck']} for p in players]}


async def run_game(request):
    speed=speed_profile()
    if speed['resident']:return await run_resident(request,speed)
    await stop_host()
    run = RUNS / uuid.uuid4().hex
    run.mkdir(parents=True, mode=0o700)
    (run/'speed.json').write_text(json.dumps(speed))
    settings = run / 'user/data/SlayTheSpire2/default/1/settings.save'
    settings.parent.mkdir(parents=True)
    settings.write_text(json.dumps({'schema_version':8,'volume_master':0,'volume_bgm':0,'volume_sfx':0,'volume_ambience':0,
        'skip_intro_logo':True,'seen_ea_disclaimer':True,'language':'eng','fps_limit':speed['fps'],
        'mod_settings':{'mods_enabled':True,'mod_list':[]}}))
    incoming = run / 'input.json'
    incoming.write_text(json.dumps(request))
    env = os.environ.copy()
    env.update(HOME=str(run/'user'), XDG_DATA_HOME=str(run/'user/data'), XDG_CONFIG_HOME=str(run/'user/config'),
        LD_LIBRARY_PATH=str(ROOT)+':'+str(ROOT/'data_sts2_linuxbsd_x86_64'),
        QQBOT_TEST_OUTPUT=str(run/'result.json'), QQBOT_TEST_CASE='duel', QQBOT_TEST_MUTED='1',
        QQBOT_RESOURCE_VARIANT='lean', QQBOT_BENCH_COUNT='1', QQBOT_DUEL_INPUT=str(incoming),
        QQBOT_DUEL_ORDER='random', QQBOT_BENCH_PHASES=str(run/'phases.jsonl'))
    started = time.monotonic()
    speed_args=['--time-scale',str(speed['scale'])]
    if speed['disableRender']:speed_args.append('--disable-render-loop')
    with (run/'console.txt').open('wb') as log:
        process = await asyncio.create_subprocess_exec('/usr/bin/time','-f','{"peakRssKiB":%M,"userSeconds":%U,"systemSeconds":%S}',
            '-o',str(run/'resources.json'),str(ROOT/'SlayTheSpire2'), '--headless', '--audio-driver', 'Dummy',
            '--force-steam=off', '--qqbot-test-enemy', '--log-file', str(run/'game.log'), *speed_args, cwd=ROOT, env=env,
            stdin=asyncio.subprocess.DEVNULL, stdout=log, stderr=asyncio.subprocess.STDOUT, start_new_session=True)
        try:
            code = await asyncio.wait_for(process.wait(), 90)
        except asyncio.TimeoutError:
            os.killpg(process.pid, signal.SIGKILL)
            await process.wait()
            return {'ok':False,'error':'timeout','run':run.name}
    result_path = run/'result.json'
    record_path = run/'alternating-duel.json'
    result = json.loads(result_path.read_text()) if result_path.exists() else {}
    log = (run/'game.log').read_text(errors='replace') if (run/'game.log').exists() else ''
    valid = code == 0 and result.get('passed') is True and result.get('modelHash') == MODEL_HASH
    valid = valid and not re.search(r'^(?:ERROR: |\[ERROR\] )System\.[A-Za-z.]*Exception:',log,re.M)
    if not valid or not record_path.exists():
        print(json.dumps({'event':'failed','run':run.name,'exit':code,'seconds':round(time.monotonic()-started,2)}),flush=True)
        return {'ok':False,'error':'game_failed','run':run.name}
    record = json.loads(record_path.read_text())
    alive = [p['id'] for p in record['turns'][-1]['after'] if p['hp'] > 0]
    if len(alive) > 1 or set(alive) != set(record['winner']):
        return {'ok':False,'error':'invalid_result','run':run.name}
    print(json.dumps({'event':'completed','run':run.name,'seconds':round(time.monotonic()-started,2),'turns':len(record['turns'])}),flush=True)
    return {'ok':True,'run':run.name,'seconds':round(time.monotonic()-started,3),'record':record}


async def handle(reader, writer):
    global busy
    acquired = False
    try:
        raw = await asyncio.wait_for(reader.readline(),5)
        request = validate(json.loads(raw))
        if busy:
            response = {'ok':False,'error':'busy'}
        else:
            busy = acquired = True
            response = await run_game(request)
    except (ValueError, KeyError, TypeError, asyncio.LimitOverrunError):
        response = {'ok':False,'error':'invalid_request'}
    except Exception as error:
        print(json.dumps({'event':'worker_error','type':type(error).__name__}),flush=True)
        response = {'ok':False,'error':'worker_error'}
    finally:
        if acquired:
            busy = False
    try:
        writer.write(json.dumps(response,ensure_ascii=False,separators=(',',':')).encode()+b'\n')
        await writer.drain()
    except (ConnectionError, BrokenPipeError):
        pass
    finally:
        writer.close()
        await writer.wait_closed()


async def main():
    RUNS.mkdir(parents=True,exist_ok=True,mode=0o700)
    SOCKET.parent.mkdir(parents=True,exist_ok=True)
    if SOCKET.exists():
        SOCKET.unlink()
    server = await asyncio.start_unix_server(handle,path=SOCKET,limit=32768)
    SOCKET.chmod(0o600)
    print(json.dumps({'event':'ready','version':'0.111.1','modelHash':MODEL_HASH}),flush=True)
    warming=asyncio.create_task(prewarm())
    try:
        async with server:
            await server.serve_forever()
    finally:
        warming.cancel()


if __name__ == '__main__':
    asyncio.run(main())
