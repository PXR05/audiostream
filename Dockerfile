FROM oven/bun:slim AS build

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

FROM oven/bun:slim AS production

WORKDIR /usr/src/app

RUN apt-get update && apt-get install -y python3 && apt-get install -y curl
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/bin/yt-dlp
RUN chmod a+rx /usr/bin/yt-dlp

COPY --from=build /app/server.js ./server.js
COPY --from=build /app/src/db/migrations ./src/db/migrations

CMD ["bun", "run", "server.js"]

EXPOSE 3000