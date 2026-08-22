FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci && npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production WAZAP_DATA_DIR=/data WAZAP_HOST=0.0.0.0 WAZAP_PORT=8766
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE README.md ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8766
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8766/healthz || exit 1
ENTRYPOINT ["node", "dist/index.js"]
CMD ["serve", "--http"]
