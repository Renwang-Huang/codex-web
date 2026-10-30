python3 - <<'PY'
import urllib.request,json,subprocess,pathlib,os,concurrent.futures
out={}
hosts_to_inspect=os.environ['INSPECT_HOSTS'].split(',')
cfg=json.load(urllib.request.urlopen('http://127.0.0.1:2019/config/',timeout=5))
routes=[]
def walk(v,host):
 if isinstance(v,dict):
  if v.get('handler')=='reverse_proxy':routes.append({'host':host,'upstreams':[u.get('dial') for u in v.get('upstreams',[])],'transport_protocol':v.get('transport',{}).get('protocol')})
  for x in v.values():walk(x,host)
 elif isinstance(v,list):
  for x in v:walk(x,host)
for s in cfg.get('apps',{}).get('http',{}).get('servers',{}).values():
 for r in s.get('routes',[]):
  hosts=[h for m in r.get('match',[]) for h in m.get('host',[]) if h in hosts_to_inspect]
  for h in hosts:walk(r,h)
out['gateway_routes']=routes
def probe(k,url):
 p=subprocess.run(['curl','-fsS','--max-time','15',url],capture_output=True,text=True,timeout=20)
 return {'probe':k,'exit':p.returncode,'body':p.stdout[:1200] if len(p.stdout)<1500 else '[non-trace omitted]','error':p.stderr[:300]}
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
 out['server_egress_probes']=list(ex.map(lambda x:probe(*x),[('generic','https://1.1.1.1/cdn-cgi/trace'),('chatgpt','https://chatgpt.com/cdn-cgi/trace')]))
p=subprocess.run(['ss','-tnp','state','established'],capture_output=True,text=True)
out['outbound_connections']=[l for l in p.stdout.splitlines() if any(n in l.lower() for n in ['nodebaby','proxy','caddy'])][:35]
print(json.dumps(out,indent=2))
PY
