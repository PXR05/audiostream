import { cors } from "@elysiajs/cors";
import openapi from "@elysiajs/openapi";
import { Elysia } from "elysia";
import { audioController } from "./modules/audio";
import { authController } from "./modules/auth";
import { playlistController } from "./modules/playlist";
import { corsConfig } from "./utils/cors";
import { logger } from "./utils/logger";

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";

const app = new Elysia()
  .use(cors(corsConfig))
  .use(openapi())
  .get("/", () => ({ message: ":)" }))
  .get("/health", () => ({ status: "ok", timestamp: new Date().toISOString() }))
  .onBeforeHandle(({ request, cookie }) => {
    // if (process.env.NODE_ENV === "production") return;

    const headers = request.headers.toJSON();
    const cookies = cookie ?? {};

    logger.info(
      [
        `${request.method} ${request.url}`,
        "Headers:",
        JSON.stringify(headers, null, 2),
        "Cookies:",
        JSON.stringify(cookies, null, 2),
      ].join("\n"),
      {
        context: "HTTP",
      },
    );
  })
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
