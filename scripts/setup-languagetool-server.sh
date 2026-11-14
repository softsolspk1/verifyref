#!/usr/bin/env bash
# setup-languagetool-server.sh - installs the Module 6 grammar server (LanguageTool) on a fresh Ubuntu 24.04 server
# (Oracle Cloud Always Free VM.Standard.A1.Flex, ARM; also works on x86 servers such as Hetzner).
#
#   sudo bash setup-languagetool-server.sh            LanguageTool only (~1 GB disk)
#   sudo bash setup-languagetool-server.sh --ngrams   also the extra data for their/there-type errors (~9 GB download, 15 GB disk)
#
# What it sets up:
#   - Java + LanguageTool, listening only inside the server (127.0.0.1:8081), restarted automatically (systemd)
#   - Caddy in front of it on https://<ip-with-dashes>.sslip.io with a free Let's Encrypt certificate, letting through only
#     requests carrying our secret token (Authorization: Bearer <token>); everything else gets 401
#   - ports 80/443 opened in the server's own firewall (Oracle's Ubuntu images block everything but SSH)
# Safe to run again: it keeps the token and updates LanguageTool to the latest stable version.
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "Run with sudo: sudo bash $0"; exit 1; }
NGRAMS=0; [ "${1:-}" = "--ngrams" ] && NGRAMS=1

LT_DIR=/opt/languagetool
NGRAM_DIR=/opt/languagetool-ngrams
PORT=8081
TOKEN_FILE=/etc/languagetool-token

echo "== 1/6 Packages"
apt-get update -q
DEBIAN_FRONTEND=noninteractive apt-get install -y -q openjdk-17-jre-headless unzip curl openssl caddy iptables-persistent

IP=$(curl -fsS https://api.ipify.org || curl -fsS https://ifconfig.me)
HOST="$(echo "$IP" | tr . -).sslip.io"
echo "Public address: $IP -> $HOST"

echo "== 2/6 LanguageTool"
id languagetool >/dev/null 2>&1 || useradd --system --home "$LT_DIR" --shell /usr/sbin/nologin languagetool
curl -fL --progress-bar -o /tmp/lt.zip https://languagetool.org/download/LanguageTool-stable.zip
rm -rf /tmp/lt && unzip -q /tmp/lt.zip -d /tmp/lt && rm /tmp/lt.zip
systemctl stop languagetool 2>/dev/null || true
rm -rf "$LT_DIR" && mkdir -p "$LT_DIR" && mv /tmp/lt/LanguageTool-*/* "$LT_DIR"/ && rm -rf /tmp/lt

if [ "$NGRAMS" = 1 ] && [ ! -d "$NGRAM_DIR/en" ]; then
  echo "== LanguageTool n-gram data (large download, takes a while)"
  mkdir -p "$NGRAM_DIR"
  curl -fL --progress-bar -o /tmp/ngrams-en.zip https://languagetool.org/download/ngram-data/ngrams-en-20150817.zip
  unzip -q /tmp/ngrams-en.zip -d "$NGRAM_DIR" && rm /tmp/ngrams-en.zip
fi

{
  echo "cacheSize=1000"
  echo "pipelineCaching=true"
  echo "maxTextLength=100000"
  echo "maxCheckTimeMillis=60000"
  [ -d "$NGRAM_DIR/en" ] && echo "languageModel=$NGRAM_DIR"
} > "$LT_DIR/server.properties"
chown -R languagetool:languagetool "$LT_DIR"

echo "== 3/6 Service (automatic start and restart)"
MEM_MB=$(free -m | awk '/^Mem:/{print $2}')
HEAP_MB=$(( MEM_MB / 2 )); [ "$HEAP_MB" -gt 12288 ] && HEAP_MB=12288
cat > /etc/systemd/system/languagetool.service <<EOF
[Unit]
Description=LanguageTool grammar server (Module 6)
After=network.target

[Service]
User=languagetool
WorkingDirectory=$LT_DIR
ExecStart=/usr/bin/java -Xms512m -Xmx${HEAP_MB}m -cp languagetool-server.jar org.languagetool.server.HTTPServer --config server.properties --port $PORT
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now languagetool

echo "== 4/6 Secret token"
[ -s "$TOKEN_FILE" ] || openssl rand -hex 32 > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"
TOKEN=$(cat "$TOKEN_FILE")

echo "== 5/6 Gatekeeper (Caddy, HTTPS) and firewall"
cat > /etc/caddy/Caddyfile <<EOF
$HOST {
	encode gzip
	@authorised header Authorization "Bearer $TOKEN"
	handle @authorised {
		reverse_proxy 127.0.0.1:$PORT
	}
	handle {
		respond "Unauthorised" 401
	}
}
EOF
for p in 80 443; do
  iptables -C INPUT -p tcp --dport $p -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null \
    || iptables -I INPUT -p tcp --dport $p -m conntrack --ctstate NEW -j ACCEPT
done
netfilter-persistent save >/dev/null
systemctl restart caddy

echo "== 6/6 Test"
for i in $(seq 1 60); do curl -fsS "http://127.0.0.1:$PORT/v2/languages" >/dev/null 2>&1 && break; sleep 2; done
LOCAL=$(curl -fsS "http://127.0.0.1:$PORT/v2/check" -d language=en-US -d "text=This are a test." | grep -o '"matches":\[{' || true)
[ -n "$LOCAL" ] && echo "LanguageTool: OK" || echo "LanguageTool: NOT answering yet - see: journalctl -u languagetool -n 50"
sleep 5
CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "https://$HOST/v2/check" -d language=en-US -d "text=This are a test." || true)
NOAUTH=$(curl -s -o /dev/null -w '%{http_code}' "https://$HOST/v2/check" -d language=en-US -d "text=Test." || true)
echo "HTTPS with token: $CODE (expect 200)   without token: $NOAUTH (expect 401)"
[ "$CODE" = 200 ] || echo "If not 200: ports 80 and 443 must be open in Oracle's Security List (Ingress, 0.0.0.0/0, TCP). Then: sudo systemctl restart caddy"

cat <<EOF

=====================================================================
Add these two settings on Vercel (Project > Settings > Environment Variables), then redeploy:

  LANGUAGETOOL_URL    https://$HOST
  LANGUAGETOOL_TOKEN  $TOKEN

Keep the token secret. It is stored on this server in $TOKEN_FILE.
=====================================================================
EOF
