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
import backfillBitDepth from "./scripts/backfillBitDepth";

async function setupDirectories() {
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
}

if (cluster.isPrimary) {
  await setupDirectories();

  await cleanupTemp();

  await Storage.init();
  logger.info(
    `Storage initialized (local path: ${Storage.getLocalStorageDir()})`,
    { context: "STARTUP" },
  );

  try {
    await migrate();
    logger.info("Database migrations completed", { context: "STARTUP" });
  } catch (error) {
    logger.error("Database migration failed", error, { context: "STARTUP" });
    console.error("Migration error:", error);
    process.exit(1);
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
