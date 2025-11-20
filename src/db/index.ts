import { type Logger } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { logger } from "../utils/logger";

let dbInstance: ReturnType<typeof drizzle> | null = null;
let pool: Pool | null = null;

// class DBLogger implements Logger {
//   logQuery(query: string, params: unknown[]): void {
//     logger.debug("QUERY: " + query, "PARAMS: " + params);
//   }
// }

export function getDb() {
  if (!dbInstance) {
    const dbUrl =
      process.env.NODE_ENV === "production"
        ? process.env.DATABASE_URL
        : process.env.DATABASE_URL_DEV;

    if (!dbUrl) throw new Error("[DB] DATABASE_URL is not set");

    pool = new Pool({
      connectionString: dbUrl,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

    pool.on("error", (err) => {
      logger.error("Unexpected error on idle client", err);
    });

    dbInstance = drizzle(pool);

    pool.query("SELECT NOW()", (err, res) => {
      if (err) {
        logger.error("Database connection test failed", err);
      }
    });
  }

  return dbInstance;
}

export async function closeDb() {
  if (pool) {
    await pool.end();
    pool = null;
    dbInstance = null;
  }
}

export const db = new Proxy({} as ReturnType<typeof drizzle>, {
  get(_, prop) {
    const database = getDb();
    const value = database[prop as keyof typeof database];
    return typeof value === "function" ? value.bind(database) : value;
  },
});
