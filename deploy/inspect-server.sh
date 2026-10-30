python3 - <<'PY'
import subprocess,json,pathlib,urllib.request
def run(args):
 p=subprocess.run(args,capture_output=True,text=True,timeout=20)
 return {'exit':p.returncode,'stdout':p.stdout[:8000],'stderr':p.stderr[:500]}
out={'caddy_version':run(['caddy','version']),'caddy_unit':run(['systemctl','show','caddy','-p','ExecStart','-p','FragmentPath'])}
try:
 cfg=json.load(urllib.request.urlopen('http://127.0.0.1:2019/config/',timeout=5))
 sites=[]
 for name,s in cfg.get('apps',{}).get('http',{}).get('servers',{}).items():
  for r in s.get('routes',[]):
   sites.append({'server':name,'listen':s.get('listen'),'matches':r.get('match'),'handlers':[h.get('handler') for h in r.get('handle',[])]})
 out['active_sites']=sites
 out['tls_policy_count']=len(cfg.get('apps',{}).get('tls',{}).get('automation',{}).get('policies',[]))
except Exception as e:out['caddy_inspection_error']=str(e)
p=pathlib.Path('/etc/caddy/Caddyfile')
if p.exists():
 out['caddyfile_structure']=[l for l in p.read_text().splitlines() if l.strip().startswith('import ') or (l.strip().endswith('{') and not l.startswith((' ','\t')))]
print(json.dumps(out,indent=2))
PY
