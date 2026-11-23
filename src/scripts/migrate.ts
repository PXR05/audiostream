import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db } from "../db";
import { logger } from "../utils/logger";

async function refreshCollationIfNeeded() {
  try {
    const res = await db.execute(
      sql.raw(
        "SELECT datname, datcollversion, pg_database_collation_actual_version(oid) AS actual_version FROM pg_database WHERE datname = current_database()",
      ),
    );
    const row = res.rows[0] as
      | {
          datname?: string;
          datcollversion?: string | null;
          actual_version?: string | null;
        }
      | undefined;
    if (
      row?.datname &&
      row.datcollversion &&
      row.actual_version &&
      row.datcollversion !== row.actual_version
    ) {
      const quotedDb = `"${row.datname.replace(/"/g, '""')}"`;
      logger.info(
        `Collation version mismatch detected (${row.datcollversion} -> ${row.actual_version}); reindexing database...`,
        { context: "DB" },
      );
      await db.execute(sql.raw(`REINDEX DATABASE ${quotedDb}`));
      await db.execute(
        sql.raw(`ALTER DATABASE ${quotedDb} REFRESH COLLATION VERSION`),
      );
      logger.info("Database collation version refreshed successfully!", {
        context: "DB",
      });
    } else if (row?.datname && row.datcollversion !== row.actual_version) {
      logger.debug(
        `Skipping collation version refresh (${row.datcollversion ?? "none"} -> ${row.actual_version ?? "none"}): PostgreSQL cannot refresh between NULL and non-NULL collation versions`,
        undefined,
        { context: "DB" },
      );
    }
  } catch (error) {
    logger.warn("Could not check/refresh database collation version", {
      context: "DB",
    });
    const cause =
      error instanceof Error
        ? (error as { cause?: unknown }).cause
        : undefined;
    logger.debug(
      cause instanceof Error
        ? `${error instanceof Error ? error.message : String(error)} (${cause.message})`
        : String(error),
      undefined,
      { context: "DB" },
    );
  }
}

async function main() {
  logger.info("Running database migrations...", { context: "DB" });
  await migrate(db, { migrationsFolder: "./src/db/migrations" });
  await refreshCollationIfNeeded();
  logger.info("Migrations completed successfully!", { context: "DB" });
}

export default main;
