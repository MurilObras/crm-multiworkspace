#!/usr/bin/env bash
set -euo pipefail

# O runner já traz índices de pacotes. Atualizar todos os repositórios antes de
# instalar travava em fontes externas sem sequer iniciar os testes. Primeiro
# usamos os índices existentes; o fallback atualiza se a versão não existir mais.
if ! command -v ffmpeg >/dev/null 2>&1; then
  apt_options=(
    -o Acquire::ForceIPv4=true
    -o Acquire::Retries=1
    -o Acquire::http::Timeout=20
    -o Acquire::https::Timeout=20
  )
  if ! timeout --kill-after=10s 90s sudo apt-get "${apt_options[@]}" install -y --no-install-recommends ffmpeg; then
    timeout --kill-after=10s 90s sudo apt-get "${apt_options[@]}" update
    timeout --kill-after=10s 90s sudo apt-get "${apt_options[@]}" install -y --no-install-recommends ffmpeg
  fi
fi

# Falha terminal se o binário não foi instalado ou não executa. O E2E continua
# validando a conversão real dos três formatos; nada é pulado por falta do ffmpeg.
ffmpeg -version
