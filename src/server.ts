import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { audioController } from "./modules/audio";
import { authController } from "./modules/auth";
import { playlistController } from "./modules/playlist";
import { logger } from "./utils/logger";
import openapi from "@elysiajs/openapi";

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";

const parseCorsOrigin = (
  origin: string | undefined
): boolean | string | RegExp | string[] => {
  if (!origin || origin === "true" || origin === "*") return true;
  if (origin === "false") return false;

  if (origin.includes(",")) {
    return origin.split(",").map((o) => o.trim());
  }

  if (origin.startsWith("/") && origin.endsWith("/")) {
    return new RegExp(origin.slice(1, -1));
  }
  return origin;
};

const corsConfig = {
  origin: parseCorsOrigin(process.env.CORS_ORIGIN),
  methods: process.env.CORS_METHODS?.split(",").map((m) => m.trim()) || "*",
  allowedHeaders:
    process.env.CORS_ALLOWED_HEADERS?.split(",").map((h) => h.trim()) || "*",
  exposedHeaders:
    process.env.CORS_EXPOSED_HEADERS?.split(",").map((h) => h.trim()) || "*",
  credentials: process.env.CORS_CREDENTIALS !== "false",
  maxAge: parseInt(process.env.CORS_MAX_AGE || "5", 10),
  preflight: process.env.CORS_PREFLIGHT !== "false",
};

const app = new Elysia()
  .use(cors(corsConfig))
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
  }
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
