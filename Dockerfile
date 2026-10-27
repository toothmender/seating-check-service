FROM node:20-alpine AS client
WORKDIR /client
COPY client/package.json ./
RUN npm install --no-audit --no-fund
COPY client/ ./
RUN npm run build

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY server/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server/ ./
COPY --from=client /client/dist ./public
USER node
EXPOSE 8080
CMD ["node", "server.js"]
