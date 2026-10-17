#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
echo "Verificando proyecto único TuVendedor WA..."
for file in app.js manager.js seguimiento-routes.js package.json package-lock.json Dockerfile docker-compose.yml; do
  test -s "$file" || { echo "Falta $file"; exit 1; }
done
node --check app.js
node --check manager.js
node --check seguimiento-routes.js
if [ -f .env.production ]; then
  echo "Configuración de producción presente (contenido no mostrado)."
else
  echo "ATENCIÓN: falta .env.production real. Conservar el archivo actual del VPS antes de levantar Docker."
fi
if command -v docker >/dev/null 2>&1; then
  docker compose -f docker-compose.yml config --quiet && echo "Docker Compose válido"
else
  echo "Docker no disponible aquí: validar Compose en el VPS."
fi
echo "Comprobación de archivos y JavaScript terminada."
