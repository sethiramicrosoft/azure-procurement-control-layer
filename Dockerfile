FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY infra ./infra
COPY scripts ./scripts
COPY docs ./docs
COPY assets ./assets
EXPOSE 3000
CMD ["npm", "start"]
