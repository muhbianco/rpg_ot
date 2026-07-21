#!/bin/sh
set -e
cd "$(dirname "$0")"

IMAGE_LOCAL="rpg_ot:latest"
IMAGE_REMOTE="muhrilobianco/rpg_ot:latest"

docker builder prune -f
docker build -t "$IMAGE_LOCAL" .
docker tag "$IMAGE_LOCAL" "$IMAGE_REMOTE"

if [ "$1" = "prod" ]; then
  docker login
  docker push "$IMAGE_REMOTE"
  echo "Imagem publicada: $IMAGE_REMOTE"
else
  echo "Build local ok: $IMAGE_LOCAL"
  echo "Tag pronta: $IMAGE_REMOTE"
  echo "Para publicar: ./build.sh prod"
fi
