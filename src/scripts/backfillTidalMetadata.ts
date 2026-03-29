import { existsSync, renameSync, unlinkSync } from "fs";
import { stat } from "fs/promises";
import { and, isNotNull, isNull, or } from "drizzle-orm";
import { extname, join } from "path";
import jimp from "jimp";
import { db } from "../db";
import { audioFiles, type AudioFile } from "../db/schema";
import { AudioRepository } from "../db/repositories";
import { AudioService } from "../modules/audio/service";
import { generateId, TEMP_DIR } from "../utils/helpers";
import { normalizeIsrc } from "../utils/isrc";
import { logger } from "../utils/logger";
import { Storage } from "../utils/storage";
import { getTidalTrackInfo, getTidalTrackIsrc } from "../utils/tidal";

const CONTEXT = "TIDAL_META_BACKFILL";
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_CONCURRENCY = 2;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return parsed;
}

function parseNonNegativeInt(
  raw: string | undefined,
  fallback: number,
): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

const BATCH_SIZE = parsePositiveInt(
  process.env.TIDAL_METADATA_BACKFILL_BATCH_SIZE,
  DEFAULT_BATCH_SIZE,
);
const CONCURRENCY = parsePositiveInt(
  process.env.TIDAL_METADATA_BACKFILL_CONCURRENCY,
  DEFAULT_CONCURRENCY,
);
const MAX_TRACKS = parseNonNegativeInt(
  process.env.TIDAL_METADATA_BACKFILL_MAX_TRACKS,
  0,
);
const ONLY_MISSING =
  process.env.TIDAL_METADATA_BACKFILL_ONLY_MISSING === "true";

type EmbedMetadata = {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  trackNumber?: number;
  discNumber?: number;
  releaseDate?: string;
  year?: number;
  genre?: string;
  composer?: string;
  copyright?: string;
  label?: string;
  upc?: string;
  explicit?: boolean;
  comment?: string;
  isrc?: string;
  coverImagePath?: string;
};

type EmbedResult = {
  ok: boolean;
  stderr: string;
};

type ProcessResult = {
  updated: number;
  skipped: number;
  failed: number;
};

async function fetchCandidates(): Promise<AudioFile[]> {
  const missingCondition = ONLY_MISSING
    ? or(
        isNull(audioFiles.title),
        isNull(audioFiles.artist),
        isNull(audioFiles.album),
        isNull(audioFiles.imageFile),
      )
    : undefined;

  const whereCondition = missingCondition
    ? and(isNotNull(audioFiles.tidalId), missingCondition)
    : isNotNull(audioFiles.tidalId);

  const query = db.select().from(audioFiles).where(whereCondition);
  if (MAX_TRACKS > 0) {
    return query.limit(MAX_TRACKS);
  }
  return query;
}

async function downloadCoverForEmbedding(
  coverUrl: string,
  audioId: string,
): Promise<string | null> {
  const tempCoverPath = join(
    TEMP_DIR,
    `tidal_cover_${audioId}_${generateId()}.jpg`,
  );
  try {
    const resp = await fetch(coverUrl, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return null;

    const image = await jimp.read(Buffer.from(await resp.arrayBuffer()));
    const w = image.getWidth();
    const h = image.getHeight();
    const s = Math.min(w, h);

    await image
      .crop(Math.floor((w - s) / 2), Math.floor((h - s) / 2), s, s)
      .quality(100)
      .writeAsync(tempCoverPath);

    return tempCoverPath;
  } catch (error) {
    logger.warn("Cover download failed for embedding", { context: CONTEXT });
    logger.debug(
      error instanceof Error ? error.message : String(error),
      undefined,
      {
        context: CONTEXT,
      },
    );
    if (existsSync(tempCoverPath)) {
      try {
        unlinkSync(tempCoverPath);
      } catch {}
    }
    return null;
  }
}

function collectMetadataPairs(
  metadata: EmbedMetadata,
): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];

  const addPair = (key: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return;
      pairs.push([key, trimmed]);
      return;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      pairs.push([key, String(value)]);
      return;
    }
    if (typeof value === "boolean") {
      pairs.push([key, value ? "1" : "0"]);
    }
  };

  addPair("title", metadata.title);
  addPair("artist", metadata.artist);
  addPair("album", metadata.album);
  addPair("album_artist", metadata.albumArtist);
  addPair("track", metadata.trackNumber);
  addPair("disc", metadata.discNumber);
  addPair("date", metadata.releaseDate);
  addPair("year", metadata.year);
  addPair("genre", metadata.genre);
  addPair("composer", metadata.composer);
  addPair("copyright", metadata.copyright);
  addPair("publisher", metadata.label);
  addPair("upc", metadata.upc);
  addPair("isrc", metadata.isrc);
  addPair(
    "comment",
    metadata.comment ?? (metadata.explicit ? "Explicit" : undefined),
  );

  return pairs;
}

async function runTaggingPass(
  filePath: string,
  outputPath: string,
  metadataPairs: Array<[string, string]>,
  coverPath?: string,
): Promise<EmbedResult> {
  const args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", filePath];

  const withCover = !!coverPath && existsSync(coverPath);
  if (withCover) {
    args.push("-i", coverPath!, "-map", "0:a", "-map", "1:v");
  } else {
    args.push("-map", "0:a");
  }

  args.push("-map_metadata", "0", "-c:a", "copy");

  if (withCover) {
    args.push(
      "-c:v",
      "mjpeg",
      "-disposition:v",
      "attached_pic",
      "-metadata:s:v",
      "title=Cover",
      "-metadata:s:v",
      "comment=Cover (front)",
    );
  }

  for (const [key, value] of metadataPairs) {
    args.push("-metadata", `${key}=${value}`);
  }

  args.push("-y", outputPath);

  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);

  return {
    ok: exitCode === 0 && existsSync(outputPath),
    stderr,
  };
}

async function embedMetadataWithCover(
  filePath: string,
  metadata: EmbedMetadata,
): Promise<void> {
  const ext = extname(filePath);
  const outputPath = ext ? `${filePath}.tagged${ext}` : `${filePath}.tagged`;
  const metadataPairs = collectMetadataPairs(metadata);

  try {
    let result = await runTaggingPass(
      filePath,
      outputPath,
      metadataPairs,
      metadata.coverImagePath,
    );

    if (!result.ok && metadata.coverImagePath) {
      if (existsSync(outputPath)) unlinkSync(outputPath);
      logger.warn(
        `Cover embedding failed, retrying without cover: ${result.stderr.substring(0, 300)}`,
        { context: CONTEXT },
      );
      result = await runTaggingPass(filePath, outputPath, metadataPairs);
    }

    if (!result.ok) {
      throw new Error(
        result.stderr.substring(0, 500) || "ffmpeg tagging failed",
      );
    }

    if (existsSync(filePath)) unlinkSync(filePath);
    renameSync(outputPath, filePath);
  } finally {
    if (existsSync(outputPath)) {
      try {
        unlinkSync(outputPath);
      } catch {}
    }
  }
}

function toGenreDbValue(
  extractedGenres: string[] | undefined,
  tidalGenre: string | undefined,
  currentValue: string | null,
): string | null {
  if (extractedGenres && extractedGenres.length > 0) {
    return JSON.stringify(extractedGenres);
  }

  if (tidalGenre) {
    return JSON.stringify([tidalGenre]);
  }

  return currentValue;
}

async function processTrack(row: AudioFile): Promise<"updated" | "skipped"> {
  if (!row.tidalId) {
    return "skipped";
  }

  const tidalId = Number.parseInt(row.tidalId, 10);
  if (!Number.isFinite(tidalId) || tidalId <= 0) {
    logger.warn(`Skipping ${row.id}: invalid tidalId ${row.tidalId}`, {
      context: CONTEXT,
    });
    return "skipped";
  }

  const extension = extname(row.filename) || ".bin";
  const tempFilePath = join(
    TEMP_DIR,
    `tidal_meta_${row.id}_${generateId()}${extension}`,
  );
  let tempCoverPath: string | null = null;

  try {
    const audioData = await Storage.download(row.filename);
    await Bun.write(tempFilePath, audioData);

    const [trackInfo, trackIsrc] = await Promise.all([
      getTidalTrackInfo(tidalId),
      getTidalTrackIsrc(tidalId),
    ]);

    if (!trackInfo && !trackIsrc) {
      logger.warn(`Skipping ${row.id}: no Tidal metadata found`, {
        context: CONTEXT,
      });
      return "skipped";
    }

    if (trackInfo?.albumCoverUrl) {
      tempCoverPath = await downloadCoverForEmbedding(
        trackInfo.albumCoverUrl,
        row.id,
      );
    }

    await embedMetadataWithCover(tempFilePath, {
      title: trackInfo?.title,
      artist: trackInfo?.artist,
      album: trackInfo?.album,
      albumArtist: trackInfo?.albumArtist,
      trackNumber: trackInfo?.trackNumber,
      discNumber: trackInfo?.discNumber,
      releaseDate: trackInfo?.releaseDate,
      year: trackInfo?.year,
      genre: trackInfo?.genre,
      composer: trackInfo?.composer,
      copyright: trackInfo?.copyright,
      label: trackInfo?.label,
      upc: trackInfo?.upc,
      explicit: trackInfo?.explicit,
      isrc: trackIsrc ?? trackInfo?.isrc ?? undefined,
      coverImagePath: tempCoverPath ?? undefined,
    });

    const [stats, extractedMetadata, extractedImage] = await Promise.all([
      stat(tempFilePath),
      AudioService.extractMetadata(tempFilePath),
      AudioService.extractAlbumArt(tempFilePath, row.id),
    ]);

    const finalIsrc =
      normalizeIsrc(
        trackIsrc ?? trackInfo?.isrc ?? extractedMetadata?.isrc ?? row.isrc,
      ) ?? null;

    const contentType = AudioService.getAudioContentType(extension);
    await Storage.uploadFromFile(row.filename, tempFilePath, contentType);

    await AudioRepository.update(row.id, {
      size: stats.size,
      title: extractedMetadata?.title ?? trackInfo?.title ?? row.title,
      artist: extractedMetadata?.artist ?? trackInfo?.artist ?? row.artist,
      album: extractedMetadata?.album ?? trackInfo?.album ?? row.album,
      year: extractedMetadata?.year ?? trackInfo?.year ?? row.year,
      genre: toGenreDbValue(
        extractedMetadata?.genre,
        trackInfo?.genre,
        row.genre,
      ),
      duration: extractedMetadata?.duration ?? row.duration,
      bitrate: extractedMetadata?.bitrate ?? row.bitrate,
      sampleRate: extractedMetadata?.sampleRate ?? row.sampleRate,
      channels: extractedMetadata?.channels ?? row.channels,
      format: extractedMetadata?.format ?? row.format,
      imageFile: extractedImage ?? row.imageFile,
      isrc: finalIsrc,
    });

    return "updated";
  } finally {
    if (existsSync(tempFilePath)) {
      try {
        unlinkSync(tempFilePath);
      } catch {}
    }
    if (tempCoverPath && existsSync(tempCoverPath)) {
      try {
        unlinkSync(tempCoverPath);
      } catch {}
    }
  }
}

async function processBatch(batch: AudioFile[]): Promise<ProcessResult> {
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let index = 0;

  const workers = Array.from(
    { length: Math.min(CONCURRENCY, batch.length) },
    async () => {
      while (true) {
        const currentIndex = index;
        index += 1;

        if (currentIndex >= batch.length) {
          return;
        }

        const row = batch[currentIndex];

        try {
          const result = await processTrack(row);
          if (result === "updated") {
            updated += 1;
          } else {
            skipped += 1;
          }
        } catch (error) {
          failed += 1;
          logger.error(`Failed to retag Tidal track ${row.id}`, error, {
            context: CONTEXT,
          });
        }
      }
    },
  );

  await Promise.all(workers);
  return { updated, skipped, failed };
}

async function main() {
  logger.info("Starting Tidal metadata backfill (manual)", {
    context: CONTEXT,
  });
  logger.info(
    `Configuration: batchSize=${BATCH_SIZE}, concurrency=${CONCURRENCY}, maxTracks=${MAX_TRACKS || "all"}, onlyMissing=${ONLY_MISSING}`,
    { context: CONTEXT },
  );

  if (!Storage.isLocalFallbackEnabled()) {
    try {
      await Storage.init();
    } catch (error) {
      if (Storage.isLocalFallbackEnabled()) {
        logger.warn(
          "Storage init failed but local fallback is already enabled; continuing backfill",
          {
            context: CONTEXT,
          },
        );
      } else {
        throw error;
      }
    }
  }

  const candidates = await fetchCandidates();
  logger.info(`Found ${candidates.length} candidate tracks`, {
    context: CONTEXT,
  });

  let totalProcessed = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let totalFailed = 0;
  let batchNumber = 0;

  for (let offset = 0; offset < candidates.length; offset += BATCH_SIZE) {
    const batch = candidates.slice(offset, offset + BATCH_SIZE);
    batchNumber += 1;

    logger.info(`Processing batch ${batchNumber} with ${batch.length} tracks`, {
      context: CONTEXT,
    });

    const result = await processBatch(batch);

    totalProcessed += batch.length;
    totalUpdated += result.updated;
    totalSkipped += result.skipped;
    totalFailed += result.failed;

    logger.info(
      `Batch ${batchNumber} done: updated=${result.updated}, skipped=${result.skipped}, failed=${result.failed}`,
      { context: CONTEXT },
    );
  }

  logger.info(
    `Backfill complete: processed=${totalProcessed}, updated=${totalUpdated}, skipped=${totalSkipped}, failed=${totalFailed}`,
    { context: CONTEXT },
  );
}

if (import.meta.main) {
  try {
    await main();
    process.exit(0);
  } catch (error) {
    logger.error("Tidal metadata backfill failed", error, {
      context: CONTEXT,
    });
    process.exit(1);
  }
}

export default main;
