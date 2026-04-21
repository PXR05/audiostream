# AudioStream

AudioStream is a Bun + Elysia backend for managing and streaming audio content.
It includes:

- Authentication and session handling
- Audio ingestion/download flows
- Playlist management
- PostgreSQL persistence (Drizzle ORM)
- Optional S3-compatible object storage support

## Deployment

If you only want to deploy and run the service.

1. Download deployment files:

   ```bash
   wget https://raw.githubusercontent.com/PXR05/audiostream/main/compose.yaml
   wget https://raw.githubusercontent.com/PXR05/audiostream/main/.env.example -O .env
   ```

2. Edit `.env` and set at minimum:
   - `ADMIN_USERNAME`
   - `ADMIN_PASSWORD`
   - `DATABASE_PASSWORD`
   - `DATABASE_URL`
   - `YOUTUBE_API_KEY` (if you use YouTube search features)

3. Start the stack:

   ```bash
   docker compose up -d
   ```

This uses the prebuilt image from GHCR defined in `compose.yaml`.

## Run locally from this repository

If you already cloned this repo and want to build and run the service locally.

1. Create env file:

   ```bash
   cp .env.example .env
   ```

2. Run with local build:

   ```bash
   docker compose -f compose.local.yaml up -d --build
   ```

## Develop locally

If you want to develop and iterate on the codebase.

1. Install dependencies:

   ```bash
   bun install
   ```

2. Start development database:

   ```bash
   docker compose -f compose.dev.yaml up -d
   ```

3. Create env file:

   ```bash
   cp .env.example .env
   ```

4. Start API:

   ```bash
   bun run dev
   ```

The API listens on `http://localhost:3000` by default.

## Compose files

- `compose.yaml`: production-style deploy using `ghcr.io/pxr05/audiostream:latest`
- `compose.local.yaml`: build image from local source
- `compose.dev.yaml`: Postgres-only for local development

## Project structure

- `src/modules` - feature modules (audio, auth, playlist)
- `src/db` - schema, migrations, repositories
- `src/utils` - shared helpers (storage, logging, integrations)
- `logs`, `uploads`, `temp` - runtime data folders
