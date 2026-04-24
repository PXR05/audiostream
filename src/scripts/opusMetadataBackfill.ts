import { mkdir } from "fs/promises";
import { existsSync, unlinkSync } from "fs";
import { join } from "path";
import type { AudioFile } from "../db/schema";
import { AudioRepository } from "../db/repositories";
import { AudioService } from "../modules/audio/service";
import { TEMP_DIR } from "../utils/helpers";
import { logger } from "../utils/logger";
import { Storage } from "../utils/storage";

const CONTEXT = "BACKFILL";

function toPatch(
  metadata: Awaited<ReturnType<typeof AudioService.extractMetadata>>,
) {
  if (!metadata) return null;
  return {
    title: metadata.title ?? null,
    artist: metadata.artist ?? null,
    album: metadata.album ?? null,
    year: metadata.year ?? null,
    genre: metadata.genre ? JSON.stringify(metadata.genre) : null,
    duration: metadata.duration ?? null,
    bitrate: metadata.bitrate ?? null,
    sampleRate: metadata.sampleRate ?? null,
    bitDepth: metadata.bitDepth ?? 0,
    channels: metadata.channels ?? null,
    format: metadata.format ?? null,
  };
}

function needsMetadataBackfill(file: AudioFile): boolean {
  return (
    file.duration === null ||
    file.duration === undefined ||
    file.bitrate === null ||
    file.bitrate === undefined
  );
}

async function snapshotCandidateFiles(): Promise<AudioFile[]> {
  const allFiles: AudioFile[] = [];
  let page = 1;
  let total = Number.POSITIVE_INFINITY;

  while (allFiles.length < total) {
    const { files, total: currentTotal } = await AudioRepository.findAll({
      page,
      limit: 20,
      sortBy: "uploadedAt",
      sortOrder: "asc",
    });

    total = currentTotal;
    if (files.length === 0) {
      break;
    }

    allFiles.push(...files);
    page++;
  }

  return allFiles.filter(needsMetadataBackfill);
}

async function main() {
  await mkdir(TEMP_DIR, { recursive: true });
  await Storage.init();

  const stats = {
    total: 0,
    processed: 0,
    updated: 0,
    failed: 0,
  };

  try {
    const candidates = await snapshotCandidateFiles();
    stats.total = candidates.length;

    logger.info(
      `OPUS backfill starting. total=${stats.total}`,
      { context: CONTEXT },
    );

    for (const file of candidates) {
      stats.processed++;

      const tempPath = join(TEMP_DIR, `meta_${file.id}_${file.filename}`);

      try {
        const data = await Storage.download(file.filename);
        await Bun.write(tempPath, data);

        const extracted = await AudioService.extractMetadata(tempPath);
        const patch = toPatch(extracted);

        if (!patch) {
          stats.failed++;
          logger.warn(`No metadata extracted for ${file.id}`, {
            context: CONTEXT,
          });
          continue;
        }

        await AudioRepository.update(file.id, patch);
        stats.updated++;
      } catch (error) {
        stats.failed++;
        logger.error(`Metadata backfill failed for ${file.id}`, error, {
          context: CONTEXT,
        });
      } finally {
        if (existsSync(tempPath)) {
          try {
            unlinkSync(tempPath);
          } catch {}
        }
      }
    }

    logger.info(
      `Metadata backfill done. total=${stats.total}, processed=${stats.processed}, updated=${stats.updated}, failed=${stats.failed}`,
      { context: CONTEXT },
    );
  } catch (error) {
    logger.error("Metadata backfill failed", error, { context: CONTEXT });
  }
}

main().catch(async (error) => {
  logger.error("Metadata backfill crashed", error, { context: CONTEXT });
  process.exit(1);
});

export default main;
