import { logger } from "../utils/logger";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db } from "../db";

async function main() {
  logger.info("Running database migrations...", { context: "DB" });
  await migrate(db, { migrationsFolder: "./src/db/migrations" });
  logger.info("Migrations completed successfully!", { context: "DB" });
}

export default main;
