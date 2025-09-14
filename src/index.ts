import { Elysia } from "elysia";
import { openapi } from "@elysiajs/openapi";
import { bearer } from "@elysiajs/bearer";
import { audioController } from "./modules/audio";

const VALID_TOKEN = process.env.TOKEN;

const authGuard = ({ bearer, set }: { bearer?: string; set: any }) => {
  if (!bearer) {
    set.status = 401;
    set.headers["WWW-Authenticate"] =
      'Bearer realm="api", error="invalid_request"';
    return { error: "Authorization header required" };
  }

  if (bearer !== VALID_TOKEN) {
    set.status = 401;
    set.headers["WWW-Authenticate"] =
      'Bearer realm="api", error="invalid_token"';
    return { error: "Invalid token" };
  }
};

const app = new Elysia()
  .use(openapi())
  .use(bearer())
  .get("/", () => ({ message: ":)" }))
  .guard(
    {
      beforeHandle: authGuard,
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
