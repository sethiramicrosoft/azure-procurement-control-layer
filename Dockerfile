FROM node:20-slim
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY public ./public
COPY infra ./infra
COPY scripts ./scripts
COPY docs ./docs
COPY assets ./assets
EXPOSE 3000
CMD ["npm", "start"]
