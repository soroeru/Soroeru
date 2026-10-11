FROM node:22-bookworm-slim AS build
WORKDIR /app/cloud
COPY cloud/package*.json ./
# NodeNext also needs an ESM package scope for the shared sources outside cloud/.
COPY cloud/package.json /app/package.json
RUN npm ci
COPY cloud/tsconfig.json ./
COPY cloud/src ./src
COPY src/shared/cloud-contract.ts /app/src/shared/cloud-contract.ts
COPY src/types.ts /app/src/types.ts
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app/cloud
COPY --from=build --chown=node:node /app/cloud/package.json ./
COPY --from=build --chown=node:node /app/cloud/node_modules ./node_modules
COPY --from=build --chown=node:node /app/cloud/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/cloud/src/main.js"]
