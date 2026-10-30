#!/usr/bin/env python3
"""Write project-owned units and link them into the current user's systemd."""
from pathlib import Path
import argparse
import re
import shutil
import subprocess
from urllib.parse import urlsplit

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--public-origin',required=True,help='Public HTTPS origin, e.g. https://codex.example.com')
parser.add_argument('--relay-host',required=True,help='Relay server IPv4 address or DNS name')
parser.add_argument('--relay-user',default='codex-relay')
parser.add_argument('--dry-run',action='store_true',help='Print units without writing files or changing services')
args=parser.parse_args()
origin=urlsplit(args.public_origin)
if (origin.scheme!='https' or not origin.hostname or origin.username or origin.password
    or origin.path not in ('','/') or origin.query or origin.fragment
    or any(c.isspace() for c in args.public_origin)):
 parser.error('--public-origin must be an HTTPS origin without credentials, path, query or fragment')
if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]*',args.relay_host):
 parser.error('--relay-host must be an IPv4 address or DNS name')
if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_-]*',args.relay_user):
 parser.error('Invalid relay user')
public_origin=origin.geturl().rstrip('/')

root=Path(__file__).resolve().parents[1]
state=root/'.local'/'deploy'
node=shutil.which('node')
ssh=shutil.which('ssh')
if not node or not ssh:
 parser.error('Both node and ssh are required')
units={
 'codex-web.service':f'''[Unit]
Description=Codex Web local agent
After=network-online.target

[Service]
WorkingDirectory={root}
Environment=HOST=127.0.0.1
Environment=PORT=4317
Environment=PUBLIC_ORIGIN={public_origin}
Environment=TRUST_LOOPBACK_PROXY=1
ExecStart={node} {root}/server/index.mjs
Restart=on-failure
RestartSec=3
TimeoutStopSec=20
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
''',
 'codex-web-tunnel.service':f'''[Unit]
Description=Codex Web encrypted LA relay
After=network-online.target codex-web.service
Wants=codex-web.service

[Service]
ExecStart={ssh} -NT -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile={state}/known_hosts -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=10 -i {state}/relay_ed25519 -R 127.0.0.1:14317:127.0.0.1:4317 {args.relay_user}@{args.relay_host}
Restart=always
RestartSec=5
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
'''}
if args.dry_run:
 for name,content in units.items():
  print('# '+name+'\n'+content)
 raise SystemExit(0)
if not (state/'relay_ed25519').is_file() or not (state/'known_hosts').is_file():
 parser.error('Prepare .local/deploy/relay_ed25519 and verified known_hosts first')
state.mkdir(parents=True,exist_ok=True)
unit_dir=Path.home()/'.config/systemd/user'
unit_dir.mkdir(parents=True,exist_ok=True)
for name,content in units.items():
 source=state/name
 source.write_text(content)
 target=unit_dir/name
 if target.exists() or target.is_symlink():
  if not target.is_symlink() or target.resolve()!=source:
   raise SystemExit('Refusing to replace an unrelated service: '+str(target))
 else:target.symlink_to(source)
subprocess.run(['systemctl','--user','daemon-reload'],check=True)
subprocess.run(['systemctl','--user','enable','--now',*units],check=True)
subprocess.run(['systemctl','--user','is-active',*units],check=True)
