FROM node:20-bookworm-slim

WORKDIR /app

# npm cache 放 /tmp，避免 /app/.npm 写入失败
ENV NODE_ENV=production \
    NPM_CONFIG_CACHE=/tmp/.npm \
    npm_config_cache=/tmp/.npm

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

CMD ["npm","start"]
