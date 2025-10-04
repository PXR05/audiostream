import { AudioRepository } from "./db/repository";
import { readdir, stat } from "fs/promises";
import { join, extname } from "path";
import { existsSync } from "fs";
import * as mm from "music-metadata";
import {
  UPLOADS_DIR,
  ALLOWED_AUDIO_EXTENSIONS,
  ALLOWED_IMAGE_EXTENSIONS,
  getImageFileName,
} from "./utils/helpers";
import type { AudioModel } from "./modules/audio/model";

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
    console.error("[META_EXTRACT]:", error);
    return null;
  }
}

async function migrateExistingFiles() {
  console.log("Starting migration of existing files...");

  try {
    const files = await readdir(UPLOADS_DIR);
    const audioFiles = files.filter((file) =>
      ALLOWED_AUDIO_EXTENSIONS.includes(extname(file).toLowerCase())
    );

    console.log(`Found ${audioFiles.length} audio files to migrate`);

    for (const filename of audioFiles) {
      const filePath = join(UPLOADS_DIR, filename);
      const stats = await stat(filePath);
      const audioId = filename.replace(/\.[^/.]+$/, "");

      const existing = await AudioRepository.findById(audioId);
      if (existing) {
        console.log(`Skipping ${filename} - already in database`);
        continue;
      }

      console.log(`Migrating ${filename}...`);

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

      console.log(`✓ Migrated ${filename}`);
    }

    console.log("Migration completed successfully!");
  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  }
}

migrateExistingFiles();
