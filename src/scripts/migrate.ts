import { AudioRepository } from "../db/repository";
import { readdir, stat } from "fs/promises";
import { join, extname } from "path";
import { existsSync } from "fs";
import * as mm from "music-metadata";
import {
  UPLOADS_DIR,
  ALLOWED_AUDIO_EXTENSIONS,
  ALLOWED_IMAGE_EXTENSIONS,
  getImageFileName,
} from "../utils/helpers";
import type { AudioModel } from "../modules/audio/model";
import { logger } from "../utils/logger";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { db } from "../db";

async function extractMetadata(
  filePath: string
): Promise<AudioModel.audioMetadata | null> {
  try {
    const metadata = await mm.parseFile(filePath);
    return {
      title: metadata.common.title,
      artist: metadata.common.artist,
      album: metadata.common.album,
      year: metadata.common.year,
      genre: metadata.common.genre,
      duration: metadata.format.duration,
      bitrate: metadata.format.bitrate,
      sampleRate: metadata.format.sampleRate,
      channels: metadata.format.numberOfChannels,
      format: metadata.format.container,
    };
  } catch (error) {
    logger.error("Metadata extraction failed", error, { context: "MIGRATE" });
    return null;
  }
}

async function main() {
  logger.info("Running database migrations...", { context: "DB" });
  migrate(db, { migrationsFolder: "./src/db/migrations" });
  logger.info("Migrations completed successfully!", { context: "DB" });

  logger.info("Starting migration of existing files...", {
    context: "MIGRATE",
  });

  try {
    const files = await readdir(UPLOADS_DIR);
    const audioFiles = files.filter((file) =>
      ALLOWED_AUDIO_EXTENSIONS.includes(extname(file).toLowerCase())
    );

    logger.info(`Found ${audioFiles.length} audio files to migrate`, {
      context: "MIGRATE",
    });

    for (const filename of audioFiles) {
      const filePath = join(UPLOADS_DIR, filename);
      const stats = await stat(filePath);
      const audioId = filename.replace(/\.[^/.]+$/, "");

      const existing = await AudioRepository.findById(audioId);
      if (existing) {
        logger.debug(`Skipping ${filename} - already in database`, undefined, {
          context: "MIGRATE",
        });
        continue;
      }

      logger.info(`Migrating ${filename}...`, { context: "MIGRATE" });

      const metadata = await extractMetadata(filePath);

      const imageFiles = ALLOWED_IMAGE_EXTENSIONS.map((ext) =>
        getImageFileName(audioId, ext)
      );

      let imageFile: string | undefined;
      for (const imgFile of imageFiles) {
        const imgPath = join(UPLOADS_DIR, imgFile);
        if (existsSync(imgPath)) {
          imageFile = imgFile;
          break;
        }
      }

      await AudioRepository.create(
        AudioRepository.fromMetadata(
          audioId,
          filename,
          stats.size,
          metadata ?? undefined,
          imageFile
        )
      );

      logger.info(`✓ Migrated ${filename}`, { context: "MIGRATE" });
    }

    logger.info("Migration completed successfully!", { context: "MIGRATE" });
  } catch (error) {
    logger.error("Migration failed", error, { context: "MIGRATE" });
  }
}

export default main;
