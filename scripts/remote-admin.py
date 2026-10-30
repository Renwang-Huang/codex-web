#!/usr/bin/env python3
"""Project-scoped SSH administration; passwords are read from the TTY only."""
import argparse
import base64
import getpass
import hashlib
import json
from pathlib import Path
import sys
import paramiko

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / '.local' / 'deploy'
STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
KNOWN = STATE / 'known_hosts'

parser = argparse.ArgumentParser()
parser.add_argument('--host', required=True)
parser.add_argument('--user', default='root')
parser.add_argument('--script', type=Path)
parser.add_argument('--key', type=Path)
parser.add_argument('--upload', nargs=2, metavar=('LOCAL', 'REMOTE'))
parser.add_argument('--interactive', action='store_true')
args = parser.parse_args()

client = paramiko.SSHClient()
if KNOWN.exists():
    client.load_host_keys(str(KNOWN))

class PinFirstHost(paramiko.MissingHostKeyPolicy):
    def missing_host_key(self, ssh, hostname, key):
        fingerprint = base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip('=')
        print('First SSH host key (TOFU): SHA256:' + fingerprint, flush=True)
        ssh.get_host_keys().add(hostname, key.get_name(), key)
        ssh.save_host_keys(str(KNOWN))
        KNOWN.chmod(0o600)

client.set_missing_host_key_policy(PinFirstHost())
password = None if args.key else getpass.getpass('SSH password (not stored): ')
try:
    client.connect(args.host, username=args.user, password=password,
                   key_filename=str(args.key) if args.key else None,
                   look_for_keys=False, allow_agent=False, timeout=15,
                   auth_timeout=20, banner_timeout=20)
    password = None
    if args.interactive:
        client.get_transport().set_keepalive(30)
        print('SSH admin session ready; JSON operations only.', flush=True)
        for line in sys.stdin:
            try:
                op = json.loads(line)
                if op.get('close'):
                    break
                if 'upload' in op:
                    with client.open_sftp() as sftp:
                        sftp.put(*op['upload'])
                    print(json.dumps({'uploaded': op['upload'][1]}), flush=True)
                    continue
                command = Path(op['script']).read_text()
                stdin, stdout, stderr = client.exec_command(command, timeout=300)
                stdin.close()
                out = stdout.read().decode(errors='replace')
                err = stderr.read().decode(errors='replace')
                code = stdout.channel.recv_exit_status()
                print(json.dumps({'exit': code, 'stdout': out, 'stderr': err}), flush=True)
            except Exception as error:
                print(json.dumps({'error': str(error)}), flush=True)
    elif args.upload:
        with client.open_sftp() as sftp:
            sftp.put(*args.upload)
        print('Uploaded project artifact')
    else:
        command = args.script.read_text() if args.script else """python3 - <<'REMOTE_PY'
import json,subprocess,shutil,pathlib
def run(args):
 p=subprocess.run(args,text=True,capture_output=True,timeout=20)
 return {'exit':p.returncode,'stdout':p.stdout[:18000],'stderr':p.stderr[:1000]}
out={'os':pathlib.Path('/etc/os-release').read_text(),'tools':{n:shutil.which(n) for n in ['node','npm','docker','caddy','nginx','certbot','ssh','sshd','python3']}}
for name,args in [('architecture',['uname','-m']),('ports',['ss','-lntp']),('resources',['df','-h','/']),('memory',['free','-m']),('services',['systemctl','list-units','--type=service','--state=running','--no-pager','--no-legend']),('ssh_forwarding',['sshd','-T']),('firewall',['ufw','status'])]:
 try:
  r=run(args)
  if name=='ssh_forwarding':r['stdout']='\\n'.join(l for l in r['stdout'].splitlines() if l.split(' ',1)[0] in ['allowtcpforwarding','gatewayports','permitlisten','pubkeyauthentication','passwordauthentication','permitrootlogin'])
  out[name]=r
 except Exception as e:out[name]={'error':str(e)}
if out['tools']['docker']:
 out['containers']=run(['docker','ps','--format','{{.Names}}\\t{{.Image}}\\t{{.Ports}}'])
print(json.dumps(out,indent=2))
REMOTE_PY"""
        stdin, stdout, stderr = client.exec_command(command, timeout=300)
        stdin.close()
        print(stdout.read().decode(errors='replace'), end='')
        err = stderr.read().decode(errors='replace')
        if err:
            print(err, file=sys.stderr, end='')
        sys.exit(stdout.channel.recv_exit_status())
finally:
    password = None
    client.close()
