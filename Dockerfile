# Una imagen única para principal y administrador multicanal.
FROM node:20-bookworm-slim
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       chromium git ca-certificates fonts-liberation fonts-noto-color-emoji dumb-init \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production WA_EXECUTABLE_PATH=/usr/bin/chromium
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY app.js seguimiento-routes.js manager.js ./
EXPOSE 3100 3200
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "app.js"]
