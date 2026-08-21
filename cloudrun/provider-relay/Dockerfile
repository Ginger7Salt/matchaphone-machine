FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server.mjs ./
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
