FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm test && npm run curriculum:validate

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/production-server.mjs ./production-server.mjs
COPY --from=build /app/server.mjs ./server.mjs
COPY --from=build /app/curriculum.mjs ./curriculum.mjs
COPY --from=build /app/lib ./lib
COPY --from=build /app/curriculum-library ./curriculum-library
RUN mkdir -p /app/curriculum-data && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "production-server.mjs"]
