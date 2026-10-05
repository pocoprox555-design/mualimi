FROM node:22-alpine AS verify
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY server.mjs ./server.mjs
COPY lib ./lib
COPY scripts ./scripts
COPY test ./test
COPY public ./public
COPY curriculum-library ./curriculum-library
RUN npm run verify

FROM node:22-alpine AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=production-dependencies --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app package.json ./package.json
COPY --chown=app:app server.mjs ./server.mjs
COPY --chown=app:app lib ./lib
COPY --chown=app:app public ./public
COPY --from=verify --chown=app:app /app/curriculum-library/search-index.json ./curriculum-library/search-index.json
COPY --from=verify --chown=app:app /app/curriculum-library/pdf-index.json ./curriculum-library/pdf-index.json
COPY --from=verify --chown=app:app /app/curriculum-library/pdf-books ./curriculum-library/pdf-books
COPY --from=verify --chown=app:app /app/curriculum-library/outlines ./curriculum-library/outlines
COPY --from=verify --chown=app:app /app/curriculum-library/pdf-sources ./curriculum-library/pdf-sources
USER app
EXPOSE 3000
CMD ["node", "server.mjs"]
