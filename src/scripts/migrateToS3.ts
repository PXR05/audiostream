import { readdir, stat } from "fs/promises";
import { existsSync, unlinkSync } from "fs";
import { join, extname, relative } from "path";
import { UPLOADS_DIR } from "../utils/helpers";
import { Storage } from "../utils/storage";
import { logger } from "../utils/logger";

const AUDIO_EXTENSIONS = [
  ".mp3",
  ".wav",
  ".flac",
  ".m4a",
  ".aac",
  ".ogg",
  ".webm",
  ".opus",
];
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".webp"];

function getContentType(ext: string): string {
  const types: Record<string, string> = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".webm": "audio/webm",
    ".opus": "audio/opus",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
  };
  return types[ext] || "application/octet-stream";
}

async function getAllFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const subFiles = await getAllFiles(fullPath);
      files.push(...subFiles);
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

export async function migrateToS3(deleteAfterMigration = false): Promise<void> {
  if (!existsSync(UPLOADS_DIR)) {
    logger.info("No uploads directory found, skipping migration", {
      context: "MIGRATION",
    });
    return;
  }

  let allFiles: string[];
  try {
    allFiles = await getAllFiles(UPLOADS_DIR);
  } catch (error) {
    logger.error("Failed to read uploads directory", error, {
      context: "MIGRATION",
    });
    return;
  }

  logger.info(`Total files found in uploads: ${allFiles.length}`, {
    context: "MIGRATION",
  });

  const validExtensions = [...AUDIO_EXTENSIONS, ...IMAGE_EXTENSIONS];
  const filesToMigrate: string[] = [];
  const skippedExtensions: Record<string, number> = {};

  for (const filePath of allFiles) {
    const ext = extname(filePath).toLowerCase();
    if (validExtensions.includes(ext)) {
      filesToMigrate.push(filePath);
    } else {
      skippedExtensions[ext || "(no extension)"] =
        (skippedExtensions[ext || "(no extension)"] || 0) + 1;
    }
  }

  if (Object.keys(skippedExtensions).length > 0) {
    logger.info(
      `Skipped files by extension: ${JSON.stringify(skippedExtensions)}`,
      {
        context: "MIGRATION",
      }
    );
  }

  if (filesToMigrate.length === 0) {
    logger.info("No files to migrate", { context: "MIGRATION" });
    return;
  }

  logger.info(`Found ${filesToMigrate.length} files to migrate`, {
    context: "MIGRATION",
  });

  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const filePath of filesToMigrate) {
    const s3Key = relative(UPLOADS_DIR, filePath).replace(/\\/g, "/");
    const ext = extname(filePath).toLowerCase();

    let fileStats;
    try {
      fileStats = await stat(filePath);
      if (!fileStats.isFile()) {
        continue;
      }
    } catch (error) {
      failed++;
      logger.error(`Failed to stat file: ${s3Key}`, error, {
        context: "MIGRATION",
      });
      continue;
    }

    const fileSizeMB = (fileStats.size / (1024 * 1024)).toFixed(2);

    try {
      const existsInS3 = await Storage.exists(s3Key);
      if (existsInS3) {
        skipped++;
        if (deleteAfterMigration) {
          unlinkSync(filePath);
          logger.debug(`Deleted local file (already in S3): ${s3Key}`, {
            context: "MIGRATION",
          });
        }
        continue;
      }

      logger.info(`Uploading: ${s3Key} (${fileSizeMB} MB)`, {
        context: "MIGRATION",
      });

      const contentType = getContentType(ext);
      await Storage.uploadFromFile(s3Key, filePath, contentType);

      migrated++;
      logger.info(`Migrated: ${s3Key} (${fileSizeMB} MB)`, {
        context: "MIGRATION",
      });

      if (deleteAfterMigration) {
        unlinkSync(filePath);
        logger.debug(`Deleted local file: ${s3Key}`, {
          context: "MIGRATION",
        });
      }
    } catch (error: any) {
      failed++;
      const errorMsg = error?.message || String(error);
      logger.error(
        `Failed to migrate: ${s3Key} (${fileSizeMB} MB) - ${errorMsg}`,
        error,
        { context: "MIGRATION" }
      );
    }
  }

  logger.info(
    `Migration complete: ${migrated} migrated, ${skipped} skipped (already in S3), ${failed} failed`,
    { context: "MIGRATION" }
  );
}

export default migrateToS3;
