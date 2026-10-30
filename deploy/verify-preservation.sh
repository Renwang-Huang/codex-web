python3 - <<'PY'
import json,os,pathlib,subprocess,urllib.request,hashlib
domain=os.environ['CODEX_WEB_DOMAIN']
backup=sorted(pathlib.Path('/opt/codex-web/backups').glob('Caddyfile.*'))[0]
p=subprocess.run(['caddy','adapt','--adapter','caddyfile','--config',str(backup)],capture_output=True,text=True,check=True)
old=json.loads(p.stdout)
new=json.load(urllib.request.urlopen('http://127.0.0.1:2019/config/'))
def routes(c):
 out={}
 def normalized(r):
  groups={}
  def walk(v):
   if isinstance(v,list):return [walk(x) for x in v]
   if not isinstance(v,dict):return v
   out={}
   for k,x in v.items():
    if k=='group':out[k]=groups.setdefault(x,'generated-group-'+str(len(groups)))
    elif k=='hide':out[k]=[s for s in x if s not in [str(backup),'/etc/caddy/Caddyfile']]
    else:out[k]=walk(x)
   return out
  return walk(r)
 for s in c.get('apps',{}).get('http',{}).get('servers',{}).values():
  for r in s.get('routes',[]):
   for m in r.get('match',[]):
    for h in m.get('host',[]):out[h]=hashlib.sha256(json.dumps(normalized(r),sort_keys=True).encode()).hexdigest()
 return out
a=routes(old);b=routes(new)
print(json.dumps({'existing_sites':len(a),'unchanged':{h:a[h]==b.get(h) for h in a},'new_site_present':domain in b},indent=2))
PY
