import sharp from "sharp";
import { logger } from "./logger";
import { Storage } from "./storage";

const DEFAULT_MAX_DIMENSION = 1000;
const DEFAULT_WEBP_QUALITY = 85;
const MAX_KNOWN_COVERS_CACHE = 10_000;

const knownCoverKeys = new Set<string>();

function rememberCoverKey(key: string) {
  if (knownCoverKeys.size >= MAX_KNOWN_COVERS_CACHE) {
    knownCoverKeys.clear();
  }
  knownCoverKeys.add(key);
}

export function hashCoverBytes(rawBytes: Uint8Array | Buffer): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(rawBytes);
  return hasher.digest("hex").slice(0, 32);
}

export function getDedupedCoverKey(rawBytes: Uint8Array | Buffer): string {
  return `cover_${hashCoverBytes(rawBytes)}.webp`;
}

async function renderSquareWebp(
  rawBytes: Uint8Array | Buffer,
  options?: { maxDimension?: number; quality?: number },
): Promise<Buffer> {
  const maxDimension = options?.maxDimension ?? DEFAULT_MAX_DIMENSION;
  const quality = options?.quality ?? DEFAULT_WEBP_QUALITY;

  const image = sharp(rawBytes, { failOn: "none" });
  const meta = await image.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  if (width <= 0 || height <= 0) {
    throw new Error("Invalid image dimensions");
  }

  const size = Math.min(width, height);
  const targetSize = Math.min(size, maxDimension);

  return await image
    .rotate()
    .resize(targetSize, targetSize, {
      fit: "cover",
      position: "centre",
      withoutEnlargement: true,
    })
    .webp({ quality })
    .toBuffer();
}

export async function processAndStoreCoverArt(
  rawBytes: Uint8Array | Buffer,
  options?: { maxDimension?: number; quality?: number },
): Promise<string | null> {
  if (!rawBytes || rawBytes.byteLength === 0) return null;

  const key = getDedupedCoverKey(rawBytes);

  if (knownCoverKeys.has(key)) {
    return key;
  }

  try {
    if (await Storage.exists(key)) {
      rememberCoverKey(key);
      return key;
    }

    const webpBuffer = await renderSquareWebp(rawBytes, options);
    await Storage.upload(key, webpBuffer, "image/webp");
    rememberCoverKey(key);
    return key;
  } catch (error) {
    logger.warn(
      `Failed to process cover art (${key}): ${error instanceof Error ? error.message : String(error)}`,
      { context: "COVER_ART" },
    );
    return null;
  }
}

export async function processCoverForEmbedding(
  rawBytes: Uint8Array | Buffer,
  outputPath: string,
  options?: { maxDimension?: number; quality?: number },
): Promise<string | null> {
  if (!rawBytes || rawBytes.byteLength === 0) return null;

  const maxDimension = options?.maxDimension ?? DEFAULT_MAX_DIMENSION;
  const quality = options?.quality ?? 95;

  try {
    const image = sharp(rawBytes, { failOn: "none" });
    const meta = await image.metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (width <= 0 || height <= 0) return null;

    const targetSize = Math.min(Math.min(width, height), maxDimension);
    await image
      .rotate()
      .resize(targetSize, targetSize, {
        fit: "cover",
        position: "centre",
        withoutEnlargement: true,
      })
      .jpeg({ quality })
      .toFile(outputPath);

    return outputPath;
  } catch (error) {
    logger.warn(
      `Failed to process cover for embedding: ${error instanceof Error ? error.message : String(error)}`,
      { context: "COVER_ART" },
    );
    return null;
  }
}

export async function extractCoverWithFfmpeg(
  filePath: string,
): Promise<Uint8Array | null> {
  try {
    const proc = Bun.spawn(
      [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        filePath,
        "-an",
        "-frames:v",
        "1",
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "-q:v",
        "2",
        "pipe:1",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    const [exitCode, stdoutBuf] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).arrayBuffer(),
    ]);

    if (exitCode !== 0 || stdoutBuf.byteLength === 0) {
      return null;
    }

    return new Uint8Array(stdoutBuf);
  } catch {
    return null;
  }
}
