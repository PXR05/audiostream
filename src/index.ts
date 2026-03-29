import { mkdir } from "fs/promises";
import cluster from "node:cluster";
import os from "node:os";
import process from "node:process";
import cleanupTemp from "./scripts/cleanupTemp";
import { TEMP_DIR, UPLOADS_DIR } from "./utils/helpers";
import { logger } from "./utils/logger";
import { Storage } from "./utils/storage";
import { AuthService } from "./modules/auth/service";
import migrate from "./scripts/migrate";
import backfillTidalMetadata from "./scripts/backfillTidalMetadata";

if (cluster.isPrimary) {
  try {
    await mkdir(TEMP_DIR, { recursive: true });
    logger.info(`Temp directory ready: ${TEMP_DIR}`, {
      context: "STARTUP",
    });
  } catch (error) {
    logger.error("Failed to create temp directory", error, {
      context: "STARTUP",
    });
    process.exit(1);
  }

  try {
    await mkdir(UPLOADS_DIR, { recursive: true });
    logger.info(`Uploads directory ready: ${UPLOADS_DIR}`, {
      context: "STARTUP",
    });
  } catch (error) {
    logger.error("Failed to create uploads directory", error, {
      context: "STARTUP",
    });
    process.exit(1);
  }

  const tempMaxAgeHours = parseInt(process.env.TEMP_MAX_AGE_HOURS || "24", 10);
  await cleanupTemp(tempMaxAgeHours);

  try {
    await Storage.init();
    logger.info("S3 storage initialized", { context: "STARTUP" });
  } catch (error) {
    logger.error("Failed to initialize S3 storage", error, {
      context: "STARTUP",
    });

    try {
      await Storage.enableLocalFallback(
        "S3 initialization failed during startup",
      );
      logger.warn(
        `Continuing startup with local fallback storage at ${Storage.getLocalFallbackDir()}`,
        { context: "STARTUP" },
      );
    } catch (fallbackError) {
      logger.error("Failed to enable local fallback storage", fallbackError, {
        context: "STARTUP",
      });
      process.exit(1);
    }
  }

  try {
    await migrate();
    logger.info("Database migrations completed", { context: "STARTUP" });
  } catch (error) {
    logger.error("Database migration failed", error, { context: "STARTUP" });
    console.error("Migration error:", error);
    process.exit(1);
  }

  try {
    await backfillTidalMetadata();
    logger.info("Tidal metadata backfill completed during startup", {
      context: "STARTUP",
    });
  } catch (error) {
    logger.error("Tidal metadata backfill failed during startup", error, {
      context: "STARTUP",
    });
  }

  await AuthService.seedAdminUser();

  if (process.env.NODE_ENV === "production") {
    for (let i = 0; i < os.availableParallelism(); i++) cluster.fork();
  } else {
    await import("./server");
    logger.info(`Worker ${process.pid} started`);
  }
} else {
  await import("./server");
  logger.info(`Worker ${process.pid} started`);
}
