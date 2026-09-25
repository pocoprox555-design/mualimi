FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY server.mjs ./server.mjs
COPY lib ./lib
COPY scripts ./scripts
COPY test ./test
COPY public ./public
COPY curriculum-library ./curriculum-library
RUN npm run verify
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app
EXPOSE 3000
CMD ["node", "server.mjs"]
