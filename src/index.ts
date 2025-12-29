import { mkdir } from "fs/promises";
import cluster from "node:cluster";
import os from "node:os";
import process from "node:process";
import migrate from "./scripts/migrate";
import migrateToS3 from "./scripts/migrateToS3";
import cleanupTemp from "./scripts/cleanupTemp";
import { TEMP_DIR } from "./utils/helpers";
import { logger } from "./utils/logger";
import { AuthService } from "./modules/auth/service";
import { Storage } from "./utils/storage";

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

  const tempMaxAgeHours = parseInt(process.env.TEMP_MAX_AGE_HOURS || "24", 10);
  await cleanupTemp(tempMaxAgeHours);

  try {
    await Storage.init();
    logger.info("S3 storage initialized", { context: "STARTUP" });
  } catch (error) {
    logger.error("Failed to initialize S3 storage", error, {
      context: "STARTUP",
    });
    process.exit(1);
  }

  try {
    const deleteAfterMigration =
      process.env.S3_DELETE_AFTER_MIGRATION === "true";
    await migrateToS3(deleteAfterMigration);
  } catch (error) {
    logger.error("S3 migration failed", error, { context: "STARTUP" });
  }

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
