FROM node:20-alpine

WORKDIR /app

RUN addgroup -S rpg && adduser -S rpg -G rpg

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public
COPY sql ./sql

ENV NODE_ENV=production
ENV PORT=3000

USER rpg
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server/index.js"]
