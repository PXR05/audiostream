import { Elysia } from "elysia";
import { openapi } from "@elysiajs/openapi";
import { bearer } from "@elysiajs/bearer";
import { audioController } from "./modules/audio";
import { authGuard } from "./utils/auth";
import { migrate } from "drizzle-orm/libsql/migrator";
import { db } from "./db";
import { logger } from "./utils/logger";

logger.info("Running database migrations...", { context: "DB" });
await migrate(db, { migrationsFolder: "./src/db/migrations" });
logger.info("Migrations completed successfully!", { context: "DB" });

const app = new Elysia()
  .use(openapi())
  .use(bearer())
  .get("/", () => ({ message: ":)" }))
  .get("/favicon.ico", () => {})
  .guard(
    {
      beforeHandle: authGuard(),
    },
    (app) => app.use(audioController)
  )
  .onError(({ request, code, error, set }) => {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    logger.error(errorMessage, error, { context: "HTTP" });
    logger.debug(`Request URL: ${request.url}`, undefined, { context: "HTTP" });

    if (code === "VALIDATION") {
      set.status = 400;
      return { error: "Validation failed", message: errorMessage };
    }

    if (code === "NOT_FOUND") {
      set.status = 404;
      return { error: "Route not found" };
    }

    set.status = 500;
    return { error: "Internal server error", message: errorMessage };
  })
  .listen(3000);

logger.info(`Server running at ${app.server?.hostname}:${app.server?.port}`, {
  context: "SERVER",
});

process.on("SIGINT", async () => {
  logger.info("Shutting down gracefully...", { context: "SERVER" });
  process.exit(0);
});

process.on("SIGTERM", async () => {
  logger.info("Shutting down gracefully...", { context: "SERVER" });
  process.exit(0);
});
