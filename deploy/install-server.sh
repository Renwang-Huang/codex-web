set -eu
umask 077
base=/opt/codex-web
stamp=$(date -u +%Y%m%dT%H%M%SZ)
if [ -e "$base" ] && [ ! -f "$base/managed-by-codex-web" ]; then
    echo 'Existing unmanaged /opt/codex-web directory; refusing to overwrite it.' >&2
    exit 1
fi
install -d -m 755 "$base" "$base/deploy" "$base/public"
install -d -m 700 "$base/backups"
touch "$base/managed-by-codex-web"
cp -p /etc/caddy/Caddyfile "$base/backups/Caddyfile.$stamp"
cp -p /etc/ssh/sshd_config "$base/backups/sshd_config.$stamp"
tar -xzf /tmp/codex-web-public.tar.gz -C "$base"
find "$base/public" -type d -exec chmod 755 {} +
find "$base/public" -type f -exec chmod 644 {} +
install -m 644 /tmp/codex-web-Caddyfile "$base/deploy/Caddyfile.codex"
if ! id codex-relay >/dev/null 2>&1; then
    useradd --system --create-home --home-dir /var/lib/codex-web-relay --shell /usr/sbin/nologin codex-relay
fi
test "$(getent passwd codex-relay | cut -d: -f6)" = /var/lib/codex-web-relay
install -d -m 700 -o codex-relay -g codex-relay /var/lib/codex-web-relay/.ssh
python3 - <<'PY'
from pathlib import Path
key=Path('/tmp/codex-web-relay.pub').read_text().strip()
Path('/var/lib/codex-web-relay/.ssh/authorized_keys').write_text('restrict,port-forwarding,permitlisten="127.0.0.1:14317" '+key+'\n')
p=Path('/etc/ssh/sshd_config')
text=p.read_text()
start='# BEGIN CODEX-WEB RELAY'
end='# END CODEX-WEB RELAY'
block='''# BEGIN CODEX-WEB RELAY
Match User codex-relay
    AllowTcpForwarding remote
    PermitListen 127.0.0.1:14317
    GatewayPorts no
    AllowAgentForwarding no
    X11Forwarding no
    PermitTTY no
    MaxSessions 0
    PasswordAuthentication no
    AuthenticationMethods publickey
# END CODEX-WEB RELAY
'''
if start in text:
 before,rest=text.split(start,1)
 text=before+rest.split(end,1)[1].lstrip('\n')
p.write_text(text.rstrip()+'\n\n'+block)
PY
chown codex-relay:codex-relay /var/lib/codex-web-relay/.ssh/authorized_keys
chmod 600 /var/lib/codex-web-relay/.ssh/authorized_keys
if ! /usr/sbin/sshd -t; then
    cp -p "$base/backups/sshd_config.$stamp" /etc/ssh/sshd_config
    exit 1
fi
systemctl reload ssh
if ! grep -Fqx 'import /opt/codex-web/deploy/Caddyfile.codex' /etc/caddy/Caddyfile; then
    printf '\nimport /opt/codex-web/deploy/Caddyfile.codex\n' >> /etc/caddy/Caddyfile
fi
if ! caddy validate --config /etc/caddy/Caddyfile; then
    cp -p "$base/backups/Caddyfile.$stamp" /etc/caddy/Caddyfile
    exit 1
fi
systemctl reload caddy
echo "Project proxy installed; previous configuration backups: $base/backups/*.$stamp"
/usr/sbin/sshd -T -C user=codex-relay,host=localhost,addr=127.0.0.1 | sed -n '/^allowtcpforwarding /p;/^permitlisten /p;/^gatewayports /p;/^maxsessions /p;/^passwordauthentication /p'
