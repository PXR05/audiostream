FROM oven/bun AS build

WORKDIR /app

COPY package.json package.json

RUN bun install --production

COPY ./src ./src

FROM oven/bun:alpine AS production

WORKDIR /usr/src/app

COPY --from=build /app/package.json .
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src

ENV NODE_ENV=production

CMD ["bun", "run", "src/index.ts"]

EXPOSE 3000