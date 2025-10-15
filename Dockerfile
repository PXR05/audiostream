FROM oven/bun AS build

WORKDIR /app

COPY package.json package.json
COPY drizzle.config.ts drizzle.config.ts
COPY bun.lock bun.lock

RUN bun install --production

COPY ./src ./src

ENV NODE_ENV=production

RUN bun build \
    --minify-whitespace \
    --minify-syntax \
    --target bun \
    --outfile server.js \
    src/index.ts

FROM oven/bun:alpine AS production

WORKDIR /usr/src/app

RUN apk -U add yt-dlp

COPY --from=build /app/server.js ./server.js
COPY --from=build /app/src/db/migrations ./src/db/migrations

CMD ["bun", "run", "server.js"]

EXPOSE 3000