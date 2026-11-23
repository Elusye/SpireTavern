"""Download public full-card images with a small, bounded worker pool."""
import concurrent.futures,hashlib,json,pathlib,time,urllib.request,urllib.error
ROOT=pathlib.Path(__file__).resolve().parent
OUT=ROOT/'wiki-cards';OUT.mkdir(exist_ok=True)
manifest=json.loads((ROOT/'wiki-card-manifest.json').read_text(encoding='utf-8'))
def download(row):
    target=OUT/row['filename']
    if target.exists() and target.read_bytes()[:8]==b'\x89PNG\r\n\x1a\n':return {**row,'ok':True,'cached':True}
    digest=hashlib.md5(row['filename'].encode()).hexdigest()
    url=f"https://huiji-public.huijistatic.com/sts2/uploads/{digest[0]}/{digest[:2]}/{row['filename']}"
    for attempt in range(2):
        try:
            time.sleep(.4)
            with urllib.request.urlopen(url,timeout=12) as response:data=response.read(8*1024*1024)
            if not data.startswith(b'\x89PNG\r\n\x1a\n'):return {**row,'ok':False,'error':'not_png','url':url}
            target.with_suffix('.tmp').write_bytes(data);target.with_suffix('.tmp').replace(target)
            return {**row,'ok':True,'bytes':len(data),'url':url}
        except urllib.error.HTTPError as error:
            if error.code in (403,429,567):time.sleep(10)
            if error.code==404 or attempt==1:return {**row,'ok':False,'error':str(error.code),'url':url}
        except Exception as error:
            if attempt==1:return {**row,'ok':False,'error':type(error).__name__,'url':url}
            time.sleep(2)
results=[]
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    for row in pool.map(download,manifest):
        results.append(row)
        if len(results)%25==0:print(json.dumps({'finished':len(results),'total':len(manifest),'ok':sum(r['ok'] for r in results)}),flush=True)
(ROOT/'wiki-card-download-results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'finished':len(results),'ok':sum(r['ok'] for r in results),'failed':sum(not r['ok'] for r in results)}),flush=True)
