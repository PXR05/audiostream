import { mkdir } from "fs/promises";
import { existsSync, unlinkSync } from "fs";
import { join } from "path";
import { AudioRepository } from "../db/repositories";
import { closeDb } from "../db";
import { AudioService } from "../modules/audio/service";
import { TEMP_DIR } from "../utils/helpers";
import { logger } from "../utils/logger";
import { Storage } from "../utils/storage";

const PAGE_SIZE = Number.parseInt(process.env.BACKFILL_PAGE_SIZE || "100", 10);

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

async function main() {
  await mkdir(TEMP_DIR, { recursive: true });
  await Storage.init();

  let page = 1;
  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  try {
    while (true) {
      const { files } = await AudioRepository.findAll({
        page,
        limit: PAGE_SIZE,
        sortBy: "uploadedAt",
        sortOrder: "asc",
      });

      if (files.length === 0) break;

      for (const file of files) {
        processed++;

        if (
          file.duration !== null &&
          file.duration !== undefined &&
          file.bitrate !== null &&
          file.bitrate !== undefined
        ) {
          skipped++;
          continue;
        }

        const tempPath = join(TEMP_DIR, `meta_${file.id}_${file.filename}`);

        try {
          const data = await Storage.download(file.filename);
          await Bun.write(tempPath, data);

          const extracted = await AudioService.extractMetadata(tempPath);
          const patch = toPatch(extracted);

          if (!patch) {
            failed++;
            logger.warn(`No metadata extracted for ${file.id}`, {
              context: "BACKFILL",
            });
            continue;
          }

          await AudioRepository.update(file.id, patch);
          updated++;
        } catch (error) {
          failed++;
          logger.error(`Metadata backfill failed for ${file.id}`, error, {
            context: "BACKFILL",
          });
        } finally {
          if (existsSync(tempPath)) {
            try {
              unlinkSync(tempPath);
            } catch {}
          }
        }
      }

      page++;
    }

    logger.info(
      `Metadata backfill done. processed=${processed}, updated=${updated}, skipped=${skipped}, failed=${failed}`,
      { context: "BACKFILL" },
    );
  } finally {
    await closeDb();
  }
}

main().catch(async (error) => {
  logger.error("Metadata backfill crashed", error, { context: "BACKFILL" });
  await closeDb();
  process.exit(1);
});

export default main;