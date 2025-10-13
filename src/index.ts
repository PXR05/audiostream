import cluster from "node:cluster";
import os from "node:os";
import process from "node:process";
import { logger } from "./utils/logger";
import migrate from "./scripts/migrate";
import { mkdir } from "fs/promises";
import { UPLOADS_DIR } from "./utils/helpers";

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

if (cluster.isPrimary) {
  for (let i = 0; i < os.availableParallelism(); i++) cluster.fork();
} else {
  await import("./server");
  console.log(`Worker ${process.pid} started`);
}
