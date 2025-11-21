import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { audioController } from "./modules/audio";
import { authController } from "./modules/auth";
import { playlistController } from "./modules/playlist";
import { logger } from "./utils/logger";
import openapi from "@elysiajs/openapi";

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";

const app = new Elysia()
  .use(cors())
  .use(openapi())
  .get("/", () => ({ message: ":)" }))
  .use(authController)
  .use(audioController)
  .use(playlistController)
  .onError(({ request, code, error, set }) => {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    logger.error(errorMessage, error, { context: "HTTP" });
    logger.debug(`Request URL: ${request.url}`, undefined, { context: "HTTP" });

    if (code === "VALIDATION") {
      set.status = 400;
      logger.debug(`Validation error: ${errorMessage}`, {
        context: "HTTP",
      });
      return { error: "Validation failed", message: errorMessage };
    }

    if (code === "NOT_FOUND") {
      set.status = 404;
      return { error: "Route not found" };
    }

    set.status = 500;
    logger.error(`Internal server error: ${errorMessage}`, {
      context: "HTTP",
    });
    return { error: "Internal server error", message: errorMessage };
  })
  .listen({
    port: PORT,
    hostname: HOST,
  });

logger.info(
  `Server running at http://${app.server?.hostname}:${app.server?.port}`,
  {
    context: "SERVER",
  },
);
logger.info(`Environment: ${process.env.NODE_ENV || "development"}`, {
  context: "SERVER",
});

process.on("SIGINT", async () => {
  logger.info("Shutting down...", { context: "SERVER" });
  process.exit(0);
});

process.on("SIGTERM", async () => {
  logger.info("Shutting down...", { context: "SERVER" });
  process.exit(0);
});
