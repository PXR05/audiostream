import { existsSync, unlinkSync } from "fs";
import { stat } from "fs/promises";
import { and, ilike, isNotNull, isNull, or } from "drizzle-orm";
import { extname, join } from "path";
import { db } from "../db";
import { audioFiles, type AudioFile } from "../db/schema";
import { AudioRepository } from "../db/repositories";
import { AudioService } from "../modules/audio/service";
import { generateId, TEMP_DIR } from "../utils/helpers";
import { logger } from "../utils/logger";
import { Storage } from "../utils/storage";

const CONTEXT = "YT_MP3_TO_OPUS_MIGRATION";
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_CONCURRENCY = 1;

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

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

const BATCH_SIZE = parsePositiveInt(
  process.env.YOUTUBE_MP3_MIGRATION_BATCH_SIZE,
  DEFAULT_BATCH_SIZE,
);
const CONCURRENCY = parsePositiveInt(
  process.env.YOUTUBE_MP3_MIGRATION_CONCURRENCY,
  DEFAULT_CONCURRENCY,
);
const MAX_TRACKS = parseNonNegativeInt(
  process.env.YOUTUBE_MP3_MIGRATION_MAX_TRACKS,
  0,
);
const DRY_RUN = parseBoolean(process.env.YOUTUBE_MP3_MIGRATION_DRY_RUN, false);

type ProcessResult = {
  migrated: number;
  skipped: number;
  failed: number;
};

async function ensureYtDlpInstalled(): Promise<void> {
  const check = Bun.spawn(["yt-dlp", "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  if ((await check.exited) !== 0) {
    const stderr = await new Response(check.stderr).text();
    throw new Error(
      `yt-dlp is required for migration and was not found: ${stderr.substring(0, 200)}`,
    );
  }
}

async function fetchCandidates(): Promise<AudioFile[]> {
  const whereCondition = and(
    isNotNull(audioFiles.youtubeId),
    isNull(audioFiles.deletedAt),
    or(
      ilike(audioFiles.filename, "%.mp3"),
      ilike(audioFiles.filename, "%.mpeg"),
      ilike(audioFiles.format, "%mpeg%"),
    ),
  );

  const query = db.select().from(audioFiles).where(whereCondition);
  if (MAX_TRACKS > 0) {
    return query.limit(MAX_TRACKS);
  }

  return query;
}

async function redownloadYoutubeToOpus(row: AudioFile): Promise<string> {
  if (!row.youtubeId) {
    throw new Error("Missing youtubeId");
  }

  const template = join(
    TEMP_DIR,
    `yt_migrate_${row.id}_${generateId()}.%(ext)s`,
  );
  const url = `https://www.youtube.com/watch?v=${row.youtubeId}`;
  const proc = Bun.spawn(
    [
      "yt-dlp",
      "--extractor-args",
      "youtube:player_client=default,mweb",
      "-f",
      "bestaudio",
      "-x",
      "--audio-format",
      "opus",
      "--embed-metadata",
      "--embed-thumbnail",
      "--parse-metadata",
      "%(artist,uploader,channel,creator)s:%(meta_artist)s",
      "--parse-metadata",
      "%(meta_artist)s:%(album_artist)s",
      "--parse-metadata",
      "%(meta_artist)s:%(artist)s",
      "--replace-in-metadata",
      "artist",
      "^([^,&]+).*",
      "\\1",
      "--no-playlist",
      "--print",
      "after_move:filepath",
      "-o",
      template,
      url,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error(
      `yt-dlp failed for ${row.id}: ${stderr.substring(0, 250) || "unknown error"}`,
    );
  }

  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (let index = lines.length - 1; index >= 0; index--) {
    const candidatePath = lines[index];
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  const fallbackOpus = template.replace("%(ext)s", "opus");
  if (existsSync(fallbackOpus)) {
    return fallbackOpus;
  }

  throw new Error(`yt-dlp did not produce an output file for ${row.id}`);
}

function pickNextFilename(audioId: string): string {
  return `${audioId}.opus`;
}

async function processTrack(row: AudioFile): Promise<"migrated" | "skipped"> {
  if (!row.youtubeId) return "skipped";

  if (extname(row.filename).toLowerCase() === ".opus") {
    return "skipped";
  }

  let downloadedFilePath: string | null = null;
  const oldFilename = row.filename;
  const nextFilename = pickNextFilename(row.id);

  try {
    downloadedFilePath = await redownloadYoutubeToOpus(row);
    const fileStats = await stat(downloadedFilePath);
    const [extractedMetadata, extractedImage] = await Promise.all([
      AudioService.extractMetadata(downloadedFilePath),
      AudioService.extractAlbumArt(downloadedFilePath, row.id),
    ]);

    if (DRY_RUN) {
      logger.info(
        `[DRY_RUN] Would migrate ${row.id}: ${oldFilename} -> ${nextFilename}`,
        {
          context: CONTEXT,
        },
      );
      return "migrated";
    }

    await Storage.uploadFromFile(
      nextFilename,
      downloadedFilePath,
      AudioService.getAudioContentType(".opus"),
    );

    if (oldFilename !== nextFilename) {
      try {
        await Storage.delete(oldFilename);
      } catch (error) {
        logger.warn(
          `Failed to delete old source file for ${row.id}: ${oldFilename}`,
          {
            context: CONTEXT,
          },
        );
      }
    }

    await AudioRepository.update(row.id, {
      filename: nextFilename,
      size: fileStats.size,
      imageFile: extractedImage ?? row.imageFile,
      title: extractedMetadata?.title ?? row.title,
      artist: extractedMetadata?.artist ?? row.artist,
      album: extractedMetadata?.album ?? row.album,
      year: extractedMetadata?.year ?? row.year,
      genre: extractedMetadata?.genre
        ? JSON.stringify(extractedMetadata.genre)
        : row.genre,
      duration: extractedMetadata?.duration ?? row.duration,
      bitrate: extractedMetadata?.bitrate ?? row.bitrate,
      sampleRate: extractedMetadata?.sampleRate ?? row.sampleRate,
      bitDepth: extractedMetadata?.bitDepth ?? row.bitDepth ?? 0,
      channels: extractedMetadata?.channels ?? row.channels,
      format: extractedMetadata?.format ?? row.format,
    });

    logger.info(
      `Migrated ${row.id}: ${oldFilename} -> ${nextFilename} (${fileStats.size} bytes)`,
      {
        context: CONTEXT,
      },
    );

    return "migrated";
  } finally {
    if (downloadedFilePath && existsSync(downloadedFilePath)) {
      try {
        unlinkSync(downloadedFilePath);
      } catch {}
    }
  }
}

async function processBatch(batch: AudioFile[]): Promise<ProcessResult> {
  let migrated = 0;
  let skipped = 0;
  let failed = 0;
  let index = 0;

  const workers = Array.from(
    { length: Math.min(CONCURRENCY, batch.length) },
    async () => {
      while (true) {
        const currentIndex = index;
        index += 1;

        if (currentIndex >= batch.length) return;

        const row = batch[currentIndex];
        try {
          const outcome = await processTrack(row);
          if (outcome === "migrated") {
            migrated += 1;
          } else {
            skipped += 1;
          }
        } catch (error) {
          failed += 1;
          logger.error(`Failed migrating ${row.id}`, error, {
            context: CONTEXT,
          });
        }
      }
    },
  );

  await Promise.all(workers);
  return { migrated, skipped, failed };
}

async function main() {
  logger.info("Starting YouTube MPEG/MP3 to Opus migration", {
    context: CONTEXT,
  });
  logger.info(
    `Configuration: batchSize=${BATCH_SIZE}, concurrency=${CONCURRENCY}, maxTracks=${MAX_TRACKS || "all"}, dryRun=${DRY_RUN}`,
    {
      context: CONTEXT,
    },
  );

  await ensureYtDlpInstalled();

  if (!Storage.isLocalStorageEnabled()) {
    try {
      await Storage.init();
    } catch (error) {
      try {
        await Storage.enableLocalStorageMode(
          "Storage init failed in YouTube mp3 migration",
        );
        logger.warn(
          `Storage init failed; continuing with local storage at ${Storage.getLocalStorageDir()}`,
          { context: CONTEXT },
        );
      } catch {
        if (!Storage.isLocalStorageEnabled()) {
          throw error;
        }
      }
    }
  }

  const candidates = await fetchCandidates();
  logger.info(`Found ${candidates.length} candidate tracks`, {
    context: CONTEXT,
  });

  if (candidates.length === 0) {
    logger.info("No matching YouTube MP3/MPEG tracks found", {
      context: CONTEXT,
    });
    return;
  }

  let totalProcessed = 0;
  let totalMigrated = 0;
  let totalSkipped = 0;
  let totalFailed = 0;
  let batchNumber = 0;

  for (let offset = 0; offset < candidates.length; offset += BATCH_SIZE) {
    const batch = candidates.slice(offset, offset + BATCH_SIZE);
    batchNumber += 1;

    logger.info(`Processing batch ${batchNumber} (${batch.length} tracks)`, {
      context: CONTEXT,
    });

    const result = await processBatch(batch);
    totalProcessed += batch.length;
    totalMigrated += result.migrated;
    totalSkipped += result.skipped;
    totalFailed += result.failed;

    logger.info(
      `Batch ${batchNumber} complete: migrated=${result.migrated}, skipped=${result.skipped}, failed=${result.failed}`,
      {
        context: CONTEXT,
      },
    );
  }

  logger.info(
    `Migration complete: processed=${totalProcessed}, migrated=${totalMigrated}, skipped=${totalSkipped}, failed=${totalFailed}, dryRun=${DRY_RUN}`,
    {
      context: CONTEXT,
    },
  );
}

if (import.meta.main) {
  try {
    await main();
    process.exit(0);
  } catch (error) {
    logger.error("YouTube MP3/MPEG migration failed", error, {
      context: CONTEXT,
    });
    process.exit(1);
  }
}

export default main;
