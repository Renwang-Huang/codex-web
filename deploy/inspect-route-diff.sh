python3 - <<'PY'
import json,os,pathlib,subprocess,urllib.request
host=os.environ['COMPARE_HOST']
backup=sorted(pathlib.Path('/opt/codex-web/backups').glob('Caddyfile.*'))[0]
old=json.loads(subprocess.run(['caddy','adapt','--adapter','caddyfile','--config',str(backup)],capture_output=True,text=True,check=True).stdout)
new=json.load(urllib.request.urlopen('http://127.0.0.1:2019/config/'))
def find(c):
 for s in c.get('apps',{}).get('http',{}).get('servers',{}).values():
  for r in s.get('routes',[]):
   if any(host in m.get('host',[]) for m in r.get('match',[])):return r
diff=[]
def walk(a,b,path=''):
 if type(a)!=type(b):diff.append({'path':path,'type_old':type(a).__name__,'type_new':type(b).__name__});return
 if isinstance(a,dict):
  for k in a.keys()|b.keys():
   if k not in a or k not in b:diff.append({'path':path+'/'+k,'missing_old':k not in a,'missing_new':k not in b})
   else:walk(a[k],b[k],path+'/'+k)
 elif isinstance(a,list):
  if len(a)!=len(b):diff.append({'path':path,'length_old':len(a),'length_new':len(b)})
  for i,(x,y) in enumerate(zip(a,b)):walk(x,y,path+'/'+str(i))
 elif a!=b:
  d={'path':path,'changed':True}
  if path.endswith(('/dial','/handler','/terminal')):d.update(old=a,new=b)
  diff.append(d)
walk(find(old),find(new))
original=backup.read_text().rstrip()
current=pathlib.Path('/etc/caddy/Caddyfile').read_text()
print(json.dumps({'original_config_prefix_preserved':current.startswith(original),'changed_fields':diff},indent=2))
PY
