FROM node:20-bookworm-slim

WORKDIR /app

# Chromium y librerías necesarias para whatsapp-web.js / Puppeteer
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       chromium \
       ca-certificates \
       fonts-liberation \
       fonts-noto-color-emoji \
       dumb-init \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV WA_EXECUTABLE_PATH=/usr/bin/chromium

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY app.js ./

EXPOSE 3100

ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "start"]
