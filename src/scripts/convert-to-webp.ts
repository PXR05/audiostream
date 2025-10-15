import { readdir, unlink } from "fs/promises";
import { join, extname } from "path";
import { existsSync } from "fs";
import jimp from "jimp";
import { UPLOADS_DIR } from "../utils/helpers";
import { logger } from "../utils/logger";

async function convertImageToWebP(
  inputPath: string,
  outputPath: string,
  quality: number = 85,
  deleteOriginal: boolean = false
): Promise<boolean> {
  try {
    const image = await jimp.read(inputPath);
    await image.quality(quality).writeAsync(outputPath);

    logger.info(`✓ Converted: ${inputPath} → ${outputPath}`, {
      context: "IMAGE_CONVERSION",
    });

    if (deleteOriginal && existsSync(outputPath)) {
      try {
        await unlink(inputPath);
        logger.info(`✓ Deleted original: ${inputPath}`, {
          context: "IMAGE_CONVERSION",
        });
      } catch (error) {
        logger.error(`Failed to delete original: ${inputPath}`, error, {
          context: "IMAGE_CONVERSION",
        });
      }
    }

    return true;
  } catch (error) {
    logger.error(`Failed to convert ${inputPath}`, error, {
      context: "IMAGE_CONVERSION",
    });
    return false;
  }
}

export async function convertAllImagesToWebP(
  quality: number = 85,
  deleteOriginals: boolean = false
): Promise<void> {
  logger.info("Starting image conversion to WebP", {
    context: "IMAGE_CONVERSION",
  });

  if (!existsSync(UPLOADS_DIR)) {
    logger.error("Uploads directory does not exist", undefined, {
      context: "IMAGE_CONVERSION",
    });
    return;
  }

  try {
    const files = await readdir(UPLOADS_DIR);
    const imageExtensions = [".jpg", ".jpeg", ".png", ".gif"];

    let converted = 0;
    let skipped = 0;
    let failed = 0;

    for (const file of files) {
      const ext = extname(file).toLowerCase();

      if (!imageExtensions.includes(ext)) {
        continue;
      }

      const inputPath = join(UPLOADS_DIR, file);
      const baseName = file.substring(0, file.lastIndexOf("."));
      const outputPath = join(UPLOADS_DIR, `${baseName}.webp`);

      if (existsSync(outputPath) && !deleteOriginals) {
        logger.info(`WebP version already exists for ${file}, skipping`, {
          context: "IMAGE_CONVERSION",
        });
        skipped++;
        continue;
      }

      logger.info(`Converting ${file} to WebP...`, {
        context: "IMAGE_CONVERSION",
      });

      const success = await convertImageToWebP(
        inputPath,
        outputPath,
        quality,
        deleteOriginals
      );

      if (success) {
        converted++;
      } else {
        failed++;
      }
    }

    logger.info(
      `Conversion complete: ${converted} converted, ${skipped} skipped, ${failed} failed`,
      { context: "IMAGE_CONVERSION" }
    );
  } catch (error) {
    logger.error("Failed to convert images", error, {
      context: "IMAGE_CONVERSION",
    });
    throw error;
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const quality = parseInt(args[0]) || 85;
  const deleteOriginals = args.includes("--delete-originals");

  logger.info(
    `Converting images with quality=${quality}, deleteOriginals=${deleteOriginals}`,
    {
      context: "IMAGE_CONVERSION",
    }
  );

  await convertAllImagesToWebP(quality, deleteOriginals);
}

export default convertAllImagesToWebP;
