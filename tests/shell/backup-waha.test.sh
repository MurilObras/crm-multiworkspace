#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT/hostgator-setup-kit/_common.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/source"
printf 'sessão sintética\n' > "$TMP/source/session.txt"
tar czf "$TMP/valid.tgz" -C "$TMP/source" .
CID=crm-multiworkspace-waha-1
MOUNT=volume
MODE=valid
dc() { [ "$*" = 'ps -aq waha' ]; printf '%s' "$CID"; }
docker() {
  printf '%s\n' "$*" >> "$TMP/docker.log"
  case "$1" in
    inspect) printf '%s' "$MOUNT" ;;
    run)
      [[ "$*" == *"--network none --volumes-from ${CID}:ro"* ]]
      [[ "$*" == *'find /app/.sessions -type f -print -quit'* ]]
      [[ "$*" == *'tar czf - -C /app/.sessions .'* ]]
      case "$MODE" in
        valid) cat "$TMP/valid.tgz" ;;
        empty) return 1 ;;
        corrupt) printf 'não é tar/gzip' ;;
      esac ;;
    *) return 1 ;;
  esac
}
backup_waha "$TMP/backup.tgz"
cmp "$TMP/valid.tgz" "$TMP/backup.tgz"
tar xzf "$TMP/backup.tgz" -O ./session.txt | cmp - "$TMP/source/session.txt"
if backup_waha "$TMP/backup.tgz"; then exit 1; fi
for CID in 'projeto-com-hifens-waha-1' 'nome-customizado-waha-1'; do
  MOUNT=bind
  backup_waha "$TMP/$CID.tgz"
done
for MODE in empty corrupt; do
  if backup_waha "$TMP/$MODE.tgz"; then exit 1; fi
  [ ! -e "$TMP/$MODE.tgz" ]
done
MODE=valid
MOUNT=
if backup_waha "$TMP/no-mount.tgz"; then exit 1; fi
MOUNT=volume
for CID in '' $'one\ntwo'; do
  if backup_waha "$TMP/no-container.tgz"; then exit 1; fi
done
! grep -q -- ' -v ' "$TMP/docker.log"
printf '✓ backup WAHA: mount real readonly, conteúdo restaurável e falhas fechadas\n'

# A sonda do registry usa o MESMO dono das imagens; mudar só IMG_NS não basta.
curl() {
  printf '%s\n' "$*" >> "$TMP/curl.log"
  case "$*" in *'/token?'*) printf '{"token":"synthetic"}' ;; *) printf 200 ;; esac
}
[ "$(ghcr_status deskcommcrm 2.0.0)" = 200 ]
grep -qF "scope=repository:${IMG_NS#ghcr.io/}/deskcommcrm:pull" "$TMP/curl.log"
grep -qF "https://ghcr.io/v2/${IMG_NS#ghcr.io/}/deskcommcrm/manifests/2.0.0" "$TMP/curl.log"
printf '✓ sonda GHCR usa o namespace do kit\n'
