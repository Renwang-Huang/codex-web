python3 - <<'PY'
import json,os,subprocess,urllib.request,socket
domain=os.environ['CODEX_WEB_DOMAIN']
out={}
for name,cmd in [('services',['systemctl','is-active','caddy','ssh']),('tunnel_socket',['ss','-lntp','sport = :14317'])]:
 p=subprocess.run(cmd,capture_output=True,text=True);out[name]={'exit':p.returncode,'stdout':p.stdout}
try:
 out['domain_addresses']=sorted({a[4][0] for a in socket.getaddrinfo(domain,443)})
except Exception as e:out['dns_error']=str(e)
try:
 r=urllib.request.urlopen('http://127.0.0.1:14317/api/auth',timeout=8)
 out['home_agent']={'status':r.status,'body':r.read(1000).decode()}
except Exception as e:out['home_agent']={'error':str(e)}
try:
 r=urllib.request.urlopen('https://'+domain+'/',timeout=10)
 out['public_https']={'status':r.status,'title_contains_codex':b'Codex Web' in r.read()}
except Exception as e:out['public_https']={'error':str(e)}
try:
 cfg=json.load(urllib.request.urlopen('http://127.0.0.1:2019/config/',timeout=5))
 out['active_hosts']=[m.get('host') for s in cfg.get('apps',{}).get('http',{}).get('servers',{}).values() for r in s.get('routes',[]) for m in r.get('match',[]) if 'host' in m]
except Exception as e:out['site_check_error']=str(e)
print(json.dumps(out,indent=2))
PY
