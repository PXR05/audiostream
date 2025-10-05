import { Elysia } from "elysia";
import { openapi } from "@elysiajs/openapi";
import { bearer } from "@elysiajs/bearer";
import { audioController } from "./modules/audio";
import { authGuard } from "./utils/auth";

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

    console.error("[ERROR]:", errorMessage);
    console.error("[REQUEST]:", request.url);

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

console.log(`Running at ${app.server?.hostname}:${app.server?.port}`);
console.log(`Database initialized at audiostream.db`);

process.on("SIGINT", async () => {
  console.log("Shutting down gracefully...");
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("Shutting down gracefully...");
  process.exit(0);
});
