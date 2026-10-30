set -eu
test -f /opt/codex-web/managed-by-codex-web
tar -xzf /tmp/codex-web-public.tar.gz -C /opt/codex-web
find /opt/codex-web/public -type d -exec chmod 755 {} +
find /opt/codex-web/public -type f -exec chmod 644 {} +
echo 'Updated project frontend assets.'
