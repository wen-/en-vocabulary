#!/bin/zsh

set -euo pipefail

ROOT_DIR="${0:A:h:h}"
CERT_DIR="$ROOT_DIR/.dev-https"
CERT_FILE="$CERT_DIR/localhost.pem"
KEY_FILE="$CERT_DIR/localhost-key.pem"
PORT="${1:-4443}"

mkdir -p "$CERT_DIR"

resolve_hosts() {
  local -a hosts
  local lan_ips
  local local_host_name=""

  if command -v scutil >/dev/null 2>&1; then
    local_host_name="$(scutil --get LocalHostName 2>/dev/null || true)"
  fi

  lan_ips=$(ifconfig | awk '/inet / { print $2 }' | grep -v '^127\.' | sort -u || true)

  hosts=(localhost 127.0.0.1 ::1)

  if [[ -n "$local_host_name" ]]; then
    hosts+=("$local_host_name.local")
    hosts+=("$local_host_name")
  fi

  while IFS= read -r ip; do
    [[ -n "$ip" ]] && hosts+=("$ip")
  done <<< "$lan_ips"

  printf '%s\n' "${hosts[@]}" | awk 'NF && !seen[$0]++'
}

resolve_lan_ips() {
  ifconfig | awk '/inet / { print $2 }' | grep -v '^127\.' | sort -u || true
}

ensure_certificate() {
  local -a hosts

  hosts=("${(@f)$(resolve_hosts)}")

  if command -v mkcert >/dev/null 2>&1; then
    if [[ ! -f "$CERT_FILE" || ! -f "$KEY_FILE" ]]; then
      mkcert -cert-file "$CERT_FILE" -key-file "$KEY_FILE" "${hosts[@]}"
    fi
    return
  fi

  if [[ ! -f "$CERT_FILE" || ! -f "$KEY_FILE" ]]; then
    local san_list
    san_list=$(printf 'DNS:localhost,DNS:%s,IP:127.0.0.1,IP:::1' "${hosts[4]:-localhost}")
    openssl req \
      -x509 \
      -nodes \
      -newkey rsa:2048 \
      -keyout "$KEY_FILE" \
      -out "$CERT_FILE" \
      -days 365 \
      -subj '/CN=localhost' \
      -addext "subjectAltName=$san_list"
  fi
}

ensure_certificate

echo "HTTPS preview root: $ROOT_DIR"
echo "HTTPS preview port: $PORT"
echo "Certificate file: $CERT_FILE"
echo "Key file: $KEY_FILE"
echo "Local URL: https://127.0.0.1:$PORT"

while IFS= read -r ip; do
  [[ -n "$ip" ]] && echo "LAN URL: https://$ip:$PORT"
done <<< "$(resolve_lan_ips)"

if command -v mkcert >/dev/null 2>&1; then
  MKCERT_CAROOT="$(mkcert -CAROOT)"
  echo 'If the certificate is shown as untrusted, run: mkcert -install'
  echo "For iPhone trust, install the root CA from: $MKCERT_CAROOT/rootCA.pem"
fi

exec python3 "$ROOT_DIR/scripts/serve_https.py" \
  --host 0.0.0.0 \
  --port "$PORT" \
  --directory "$ROOT_DIR" \
  --cert "$CERT_FILE" \
  --key "$KEY_FILE"