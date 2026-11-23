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
--external onnxruntime-node \
--external taglib-wasm \
--external sharp \
--outfile server.js \
src/index.ts

FROM oven/bun:slim AS production

WORKDIR /usr/src/app

COPY --from=mwader/static-ffmpeg:latest /ffmpeg /usr/local/bin/
COPY --from=mwader/static-ffmpeg:latest /ffprobe /usr/local/bin/

COPY --from=build /app/server.js ./server.js
COPY --from=build /app/src/db/migrations ./src/db/migrations
COPY --from=build /app/node_modules/onnxruntime-node ./node_modules/onnxruntime-node
COPY --from=build /app/node_modules/onnxruntime-common ./node_modules/onnxruntime-common
COPY --from=build /app/node_modules/taglib-wasm ./node_modules/taglib-wasm
COPY --from=build /app/node_modules/@msgpack ./node_modules/@msgpack
COPY --from=build /app/node_modules/sharp ./node_modules/sharp
COPY --from=build /app/node_modules/@img ./node_modules/@img
COPY --from=build /app/node_modules/detect-libc ./node_modules/detect-libc
COPY --from=build /app/node_modules/semver ./node_modules/semver

ENV NODE_ENV=production

CMD ["bun", "run", "server.js"]

EXPOSE 3000