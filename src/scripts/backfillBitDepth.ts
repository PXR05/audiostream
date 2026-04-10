import { existsSync, unlinkSync } from "fs";
import { join, extname } from "path";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { audioFiles, type AudioFile } from "../db/schema";
import { AudioRepository } from "../db/repositories";
import { AudioService } from "../modules/audio/service";
import { generateId, TEMP_DIR } from "../utils/helpers";
import { logger } from "../utils/logger";
import { Storage } from "../utils/storage";
import { getDownloadUrl } from "../utils/tidal";

const CONTEXT = "BIT_DEPTH_BACKFILL";
const DEFAULT_BATCH_SIZE = 25;
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
  process.env.BIT_DEPTH_BACKFILL_BATCH_SIZE,
  DEFAULT_BATCH_SIZE,
);
const CONCURRENCY = parsePositiveInt(
  process.env.BIT_DEPTH_BACKFILL_CONCURRENCY,
  DEFAULT_CONCURRENCY,
);
const MAX_TRACKS = parseNonNegativeInt(
  process.env.BIT_DEPTH_BACKFILL_MAX_TRACKS,
  0,
);

async function fetchCandidates(): Promise<AudioFile[]> {
  const query = db.select().from(audioFiles).where(eq(audioFiles.bitDepth, 0));
  if (MAX_TRACKS > 0) {
    return query.limit(MAX_TRACKS);
  }
  return query;
}

function normalizeBitDepth(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const bitDepth = Math.trunc(value);
  return bitDepth > 0 ? bitDepth : null;
}

async function resolveBitDepthFromStoredFile(
  file: AudioFile,
): Promise<number | null> {
  const extension = extname(file.filename) || ".bin";
  const tempFilePath = join(
    TEMP_DIR,
    `bit_depth_${file.id}_${generateId()}${extension}`,
  );

  try {
    const audioData = await Storage.download(file.filename);
    await Bun.write(tempFilePath, audioData);

    const metadata = await AudioService.extractMetadata(tempFilePath);
    return normalizeBitDepth(metadata?.bitDepth);
  } catch (error) {
    logger.warn(
      `Failed to extract local bit depth for ${file.id}: ${file.filename}`,
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

async function resolveBitDepthFromRemote(
  file: AudioFile,
): Promise<number | null> {
  if (!file.tidalId) return null;

  const tidalId = Number.parseInt(file.tidalId, 10);
  if (!Number.isFinite(tidalId) || tidalId <= 0) return null;

  try {
    const lossless = await getDownloadUrl(tidalId, "LOSSLESS");
    const bitDepth = normalizeBitDepth(lossless.bitDepth);
    if (bitDepth) return bitDepth;
  } catch (error) {
    logger.debug(
      `LOSSLESS bit depth lookup failed for ${file.id}`,
      error instanceof Error ? error : undefined,
      { context: CONTEXT },
    );
  }

  try {
    const high = await getDownloadUrl(tidalId, "HIGH");
    return normalizeBitDepth(high.bitDepth);
  } catch (error) {
    logger.debug(
      `HIGH bit depth lookup failed for ${file.id}`,
      error instanceof Error ? error : undefined,
      { context: CONTEXT },
    );
    return null;
  }
}

async function resolveBitDepth(file: AudioFile): Promise<number | null> {
  const fromLocal = await resolveBitDepthFromStoredFile(file);
  if (fromLocal) return fromLocal;

  return resolveBitDepthFromRemote(file);
}

type ProcessResult = {
  updated: number;
  skipped: number;
  failed: number;
};

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
          const bitDepth = await resolveBitDepth(row);
          if (!bitDepth) {
            skipped += 1;
            continue;
          }

          await AudioRepository.update(row.id, { bitDepth });
          updated += 1;
        } catch (error) {
          failed += 1;
          logger.error(`Failed to backfill bit depth for ${row.id}`, error, {
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
  logger.info("Starting bit depth backfill (manual)", { context: CONTEXT });
  logger.info(
    `Configuration: batchSize=${BATCH_SIZE}, concurrency=${CONCURRENCY}, maxTracks=${MAX_TRACKS || "all"}`,
    { context: CONTEXT },
  );

  if (!Storage.isLocalStorageEnabled()) {
    try {
      await Storage.init();
    } catch (error) {
      try {
        await Storage.enableLocalStorageMode(
          "Storage init failed in bit depth backfill",
        );
        logger.warn(
          `Storage init failed; continuing with local storage at ${Storage.getLocalStorageDir()}`,
          {
            context: CONTEXT,
          },
        );
      } catch {
        if (Storage.isLocalStorageEnabled()) {
          logger.warn(
            "Storage init failed but local storage mode is already enabled; continuing backfill",
            {
              context: CONTEXT,
            },
          );
        } else {
          throw error;
        }
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
    logger.error("Bit depth backfill failed", error, { context: CONTEXT });
    process.exit(1);
  }
}

export default main;
