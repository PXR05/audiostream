# AudioStream

An audio streaming API built with Bun and Elysia. Upload, manage, and stream audio files with automatic metadata extraction, YouTube audio downloading, and thumbnail support.

## Getting Started

### Prerequisites

- Bun runtime installed
- yt-dlp (for YouTube downloads)

### Installation

```bash
# Install dependencies
bun install

# Initialize database
bun db:push

# (Optional) Import existing audio files
bun migrate-files

# Start development server
bun dev
```

The server will start on `http://localhost:3000`

### Configuration

#### Environment Variables

Create a `.env` file (optional):

```env
# Bearer token for authentication (production only)
TOKEN=your-secret-token-here
```

#### YouTube Downloads with Cookies (Optional)

For authenticated YouTube downloads, place a `cookies.txt` file in the project root:

```bash
# Export cookies from your browser using a browser extension
# Place the file as: cookies.txt
```

## API Documentation

Interactive OpenAPI documentation is available at `/openapi`

## Database Management

```bash
bun db:push         # Push schema to database
bun db:studio       # Open database GUI
bun migrate-files   # Import existing audio files
```

## How It Works

### Metadata Management

The system uses a two-tier metadata caching strategy:

1. **In-Memory Cache**: Fast access to frequently requested metadata
2. **Persistent Cache**: `metadata.json` file stores extracted metadata
3. **Fallback Reading**: If cache misses, reads ID3 tags directly from audio files

This ensures metadata is always available even if the cache file is deleted.

### File Storage

- All uploaded audio files are stored in the `uploads/` directory
- Files are renamed with unique IDs to prevent conflicts
- Album art is extracted and stored alongside audio files as `{id}_image.{ext}`

### YouTube Downloads

Uses `yt-dlp` with the following features:

- Best quality audio extraction
- Automatic metadata embedding
- Thumbnail extraction and embedding
- Cookie support for age-restricted content
- Playlist support

## Authentication

In production mode (`NODE_ENV=production`), all API endpoints require bearer token authentication:

```bash
curl -H "Authorization: Bearer your-token-here" http://localhost:3000/audio
```

Development mode has no authentication requirements.
