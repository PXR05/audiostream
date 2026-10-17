# AudioStream

AudioStream is a Bun + Elysia backend for managing and streaming audio content.
It includes:

- Authentication and session handling
- Audio ingestion/download flows
- Playlist management
- Song radio (ONNX audio embeddings + `pgvector`)
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

- `src/modules` - feature modules (audio, auth, playlist, radio, user)
- `src/db` - schema, migrations, repositories
- `src/utils` - shared helpers (storage, logging, integrations, radio DSP/ONNX)
- `logs`, `uploads`, `temp`, `models` - runtime data folders

## Feature Requirements

- **Database (`pgvector`)**: Requires `pgvector/pgvector:pg17` (configured in `compose.yaml` and `compose.dev.yaml`). Migrations and Alpine-to-Debian collation refreshes run automatically on startup.
- **Song Radio (`/audio/radio`)**: Models are kept external (not in Git or the Docker image). Create a `models` folder in the project root (`./models`, mounted to `/usr/src/app/models` in Docker) and place the ONNX model file inside:
  ```bash
  mkdir -p models
  wget https://essentia.upf.edu/models/feature-extractors/discogs-effnet/discogs-effnet-bsdynamic-1.onnx -O models/effnet.onnx
  ```
- **YouTube (`/audio/search/youtube`, `/audio/upload/youtube`)**: Search uses `ytmusic-api` by default or `YOUTUBE_API_KEY` if set. Downloads require `yt-dlp`, `ffmpeg`, and `deno` (pre-installed in Docker). To bypass bot/age checks, mount `./cookies.txt` and/or enable the `pot-provider` container (`YOUTUBE_USE_POT=true`, `YOUTUBE_POT_URL=http://pot-provider:4416`).
- **Tidal (`/audio/search/tidal`, `/audio/upload/tidal`)**: Uses built-in community proxies by default (override via `TIDAL_PROXY_LIST_URL`). Local non-Docker runs require `ffmpeg` and `python3-mutagen` for FLAC tagging.
- **Object Storage**: Uses local `./uploads` by default. Set `S3_ENDPOINT`, `S3_BUCKET_NAME`, `S3_ACCESS_KEY`, and `S3_SECRET_KEY` in `.env` (and uncomment `s3` in `compose.yaml` if using RustFS) to use S3 storage.
