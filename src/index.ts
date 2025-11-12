import { mkdir } from "fs/promises";
import cluster from "node:cluster";
import os from "node:os";
import process from "node:process";
// import convertAllImagesToWebP from "./scripts/convert-to-webp";
import migrate from "./scripts/migrate";
import { UPLOADS_DIR } from "./utils/helpers";
import { logger } from "./utils/logger";
import { AuthService } from "./modules/auth/service";

if (cluster.isPrimary) {
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

  try {
    await migrate();
    logger.info("Database migrations completed", { context: "STARTUP" });
  } catch (error) {
    logger.error("Database migration failed", error, { context: "STARTUP" });
    process.exit(1);
  }

  // try {
  //   await convertAllImagesToWebP(85, false);
  //   logger.info("Image conversion to WebP completed", { context: "STARTUP" });
  // } catch (error) {
  //   logger.error("Image conversion to WebP failed", error, {
  //     context: "STARTUP",
  //   });
  // }
  
  await AuthService.seedAdminUser();
  
  for (let i = 0; i < os.availableParallelism(); i++) cluster.fork();
} else {
  await import("./server");
  logger.info(`Worker ${process.pid} started`);
}
