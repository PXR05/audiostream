import { readdir, stat, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { TEMP_DIR } from "../utils/helpers";
import { logger } from "../utils/logger";

const DEFAULT_MAX_AGE_HOURS = 24;

export async function cleanupTemp(
  maxAgeHours = DEFAULT_MAX_AGE_HOURS
): Promise<void> {
  if (!existsSync(TEMP_DIR)) {
    return;
  }

  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  const now = Date.now();

  let files: string[];
  try {
    files = await readdir(TEMP_DIR);
  } catch (error) {
    logger.error("Failed to read temp directory", error, {
      context: "CLEANUP",
    });
    return;
  }

  let deleted = 0;
  let kept = 0;
  let errors = 0;

  for (const filename of files) {
    const filePath = join(TEMP_DIR, filename);

    try {
      const fileStats = await stat(filePath);
      if (!fileStats.isFile()) continue;

      const age = now - fileStats.mtimeMs;
      if (age > maxAgeMs) {
        await unlink(filePath);
        deleted++;
      } else {
        kept++;
      }
    } catch (error) {
      errors++;
      logger.error(`Failed to process temp file: ${filename}`, error, {
        context: "CLEANUP",
      });
    }
  }

  if (deleted > 0 || errors > 0) {
    logger.info(
      `Temp cleanup: ${deleted} deleted, ${kept} kept, ${errors} errors`,
      { context: "CLEANUP" }
    );
  }
}

export default cleanupTemp;
