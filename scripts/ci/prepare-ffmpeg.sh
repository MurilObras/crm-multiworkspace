#!/usr/bin/env bash
set -euo pipefail

# O Playwright também usa APT mais tarde. No runner descartável do GitHub,
# substituímos apenas o mirror Azure conhecido pelo arquivo oficial do Ubuntu:
# o mirror lento já bloqueou o ffmpeg e a instalação do browser no mesmo run.
# As fontes, suítes e chaves assinantes continuam sendo as do runner.
if [[ "${GITHUB_ACTIONS:-}" == true && -f /etc/apt/apt-mirrors.txt ]]; then
  sudo sed -i -E 's#https?://azure.archive.ubuntu.com/ubuntu/?#https://archive.ubuntu.com/ubuntu/#g' /etc/apt/apt-mirrors.txt
fi

# Primeiro tentamos os índices do runner. Se falharem, o fallback usa índices
# novos dos repositórios oficiais com assinatura APT e fontes temporárias.
if ! command -v ffmpeg >/dev/null 2>&1; then
  apt_options=(
    -o Acquire::ForceIPv4=true
    -o Acquire::Retries=1
    -o Acquire::http::Timeout=20
    -o Acquire::https::Timeout=20
  )
  if ! timeout --kill-after=10s 90s sudo apt-get "${apt_options[@]}" install -y --no-install-recommends ffmpeg; then
    # Dois runs pararam no mesmo pacote de 9 MB do mirror Azure, inclusive
    # depois de atualizar os índices. Repetir a mesma origem não era recuperação.
    . /etc/os-release
    [[ "$ID" == ubuntu && "${VERSION_CODENAME:-}" =~ ^[a-z]+$ ]] || {
      echo 'Fallback APT requer um runner Ubuntu com codename conhecido.' >&2
      exit 1
    }
    case "$(dpkg --print-architecture)" in
      amd64|i386) archive=https://archive.ubuntu.com/ubuntu; security=https://security.ubuntu.com/ubuntu ;;
      arm64|armhf|ppc64el|riscv64|s390x) archive=https://ports.ubuntu.com/ubuntu-ports; security="$archive" ;;
      *) echo 'Arquitetura APT não suportada pelo fallback.' >&2; exit 1 ;;
    esac
    apt_fallback="$(mktemp -d)"
    trap 'rm -rf -- "$apt_fallback"' EXIT
    chmod 755 "$apt_fallback"
    cat > "$apt_fallback/ubuntu.list" <<EOF
deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] $archive $VERSION_CODENAME main universe
deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] $archive $VERSION_CODENAME-updates main universe
deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] $security $VERSION_CODENAME-security main universe
EOF
    apt_options+=(
      -o "Dir::Etc::sourcelist=$apt_fallback/ubuntu.list"
      -o Dir::Etc::sourceparts=-
      -o APT::Update::Error-Mode=any
    )
    timeout --kill-after=10s 90s sudo apt-get "${apt_options[@]}" update
    timeout --kill-after=10s 180s sudo apt-get "${apt_options[@]}" install -y --no-install-recommends ffmpeg
  fi
fi

# Falha terminal se o binário não foi instalado ou não executa. O E2E continua
# validando a conversão real dos três formatos; nada é pulado por falta do ffmpeg.
ffmpeg -version
