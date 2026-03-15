import { existsSync, unlinkSync } from "fs";
import { join, extname } from "path";
import { and, eq, isNull, isNotNull, or } from "drizzle-orm";
import { db } from "../db";
import { audioFiles, type AudioFile } from "../db/schema";
import { AudioRepository } from "../db/repositories";
import { AudioService } from "../modules/audio/service";
import { generateId, TEMP_DIR } from "../utils/helpers";
import { NO_ISRC_SENTINEL, normalizeIsrc } from "../utils/isrc";
import { logger } from "../utils/logger";
import { Storage } from "../utils/storage";
import { getTidalTrackIsrc } from "../utils/tidal";
import { getIsrcFromDeezerSearch } from "../utils/deezer";

const CONTEXT = "ISRC_BACKFILL";
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_CONCURRENCY = 3;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return parsed;
}

const BATCH_SIZE = parsePositiveInt(
  process.env.ISRC_BACKFILL_BATCH_SIZE,
  DEFAULT_BATCH_SIZE,
);
const CONCURRENCY = parsePositiveInt(
  process.env.ISRC_BACKFILL_CONCURRENCY,
  DEFAULT_CONCURRENCY,
);
const RETRY_NO_ISRC = process.env.ISRC_BACKFILL_RETRY_NO_ISRC === "true";
const MAX_TRACKS = parsePositiveInt(process.env.ISRC_BACKFILL_MAX_TRACKS, 0);

async function fetchCandidates(): Promise<AudioFile[]> {
  const pendingIsrcCondition = RETRY_NO_ISRC
    ? or(isNull(audioFiles.isrc), eq(audioFiles.isrc, NO_ISRC_SENTINEL))
    : isNull(audioFiles.isrc);

  const query = db
    .select()
    .from(audioFiles)
    .where(
      and(
        pendingIsrcCondition,
        or(isNotNull(audioFiles.youtubeId), isNotNull(audioFiles.tidalId)),
      ),
    );

  if (MAX_TRACKS > 0) {
    return query.limit(MAX_TRACKS);
  }

  return query;
}

async function extractIsrcFromStoredFile(
  file: AudioFile,
): Promise<string | null> {
  const extension = extname(file.filename) || ".bin";
  const tempFilePath = join(
    TEMP_DIR,
    `isrc_${file.id}_${generateId()}${extension}`,
  );

  try {
    const audioData = await Storage.download(file.filename);
    await Bun.write(tempFilePath, audioData);

    const metadata = await AudioService.extractMetadata(tempFilePath);
    return normalizeIsrc(metadata?.isrc);
  } catch (error) {
    logger.warn(
      `Failed to extract ISRC from stored file for ${file.id}: ${file.filename}`,
      { context: CONTEXT },
    );
    logger.debug(
      error instanceof Error ? error.message : String(error),
      undefined,
      { context: CONTEXT },
    );
    return null;
  } finally {
    if (existsSync(tempFilePath)) {
      try {
        unlinkSync(tempFilePath);
      } catch {}
    }
  }
}

async function resolveIsrc(file: AudioFile): Promise<string> {
  if (file.tidalId) {
    const tidalId = Number.parseInt(file.tidalId, 10);
    if (Number.isFinite(tidalId) && tidalId > 0) {
      const fromTidal = await getTidalTrackIsrc(tidalId);
      if (fromTidal) {
        return fromTidal;
      }
    }
  }

  if (file.youtubeId) {
    const fromDeezer = await getIsrcFromDeezerSearch({
      title: file.title,
      artist: file.artist,
    });
    if (fromDeezer) {
      return fromDeezer;
    }
  }

  const fromFile = await extractIsrcFromStoredFile(file);
  if (fromFile) {
    return fromFile;
  }

  return NO_ISRC_SENTINEL;
}

type ProcessResult = {
  resolved: number;
  marked: number;
  failed: number;
};

async function processBatch(batch: AudioFile[]): Promise<ProcessResult> {
  let resolved = 0;
  let marked = 0;
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
          const isrc = await resolveIsrc(row);
          await AudioRepository.update(row.id, { isrc });

          if (isrc === NO_ISRC_SENTINEL) {
            marked += 1;
          } else {
            resolved += 1;
          }
        } catch (error) {
          failed += 1;
          logger.error(`Failed to backfill ISRC for ${row.id}`, error, {
            context: CONTEXT,
          });
        }
      }
    },
  );

  await Promise.all(workers);

  return { resolved, marked, failed };
}

async function main() {
  logger.info("Starting ISRC backfill (manual)", { context: CONTEXT });
  logger.info(
    `Configuration: batchSize=${BATCH_SIZE}, concurrency=${CONCURRENCY}, retryNoIsrc=${RETRY_NO_ISRC}, maxTracks=${MAX_TRACKS || "all"}`,
    { context: CONTEXT },
  );

  await Storage.init();

  const candidates = await fetchCandidates();
  logger.info(`Found ${candidates.length} candidate tracks`, {
    context: CONTEXT,
  });

  let totalProcessed = 0;
  let totalResolved = 0;
  let totalMarked = 0;
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
    totalResolved += result.resolved;
    totalMarked += result.marked;
    totalFailed += result.failed;

    logger.info(
      `Batch ${batchNumber} done: resolved=${result.resolved}, marked_no_isrc=${result.marked}, failed=${result.failed}`,
      { context: CONTEXT },
    );
  }

  logger.info(
    `Backfill complete: processed=${totalProcessed}, resolved=${totalResolved}, marked_no_isrc=${totalMarked}, failed=${totalFailed}`,
    { context: CONTEXT },
  );
}

if (import.meta.main) {
  try {
    await main();
    process.exit(0);
  } catch (error) {
    logger.error("ISRC backfill failed", error, { context: CONTEXT });
    process.exit(1);
  }
}

export default main;
