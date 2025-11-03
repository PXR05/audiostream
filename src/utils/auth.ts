import { Elysia } from "elysia";
import { bearer } from "@elysiajs/bearer";
import { logger } from "./logger";
import { verifyJWT } from "../modules/auth/service";

export type AuthData = {
  userId: string;
  username: string;
  role: "admin" | "user";
  isAdmin: boolean;
};

export const authPlugin = new Elysia({ name: "auth" }).use(bearer()).macro({
  isAuth(enabled: boolean) {
    if (!enabled) return;

    return {
      resolve: async ({ bearer, set, store }) => {
        const storeWithAuth = store as typeof store & { auth?: AuthData };

        if (!bearer) {
          set.status = 401;
          set.headers["WWW-Authenticate"] =
            'Bearer realm="api", error="invalid_request"';
          throw new Error("Authorization header required");
        }

        try {
          const payload = await verifyJWT(bearer);

          const authData: AuthData = {
            userId: payload.userId,
            username: payload.username,
            role: payload.role,
            isAdmin: payload.role === "admin",
          };

          storeWithAuth.auth = authData;
          return { auth: authData };
        } catch (error) {
          logger.error("JWT verification failed", error, { context: "AUTH" });
          set.status = 401;
          set.headers["WWW-Authenticate"] =
            'Bearer realm="api", error="invalid_token"';
          throw new Error("Invalid or expired token");
        }
      },
    };
  },
  isAdmin(enabled: boolean) {
    if (!enabled) return;

    return {
      resolve: async ({ bearer, set, store }) => {
        const storeWithAuth = store as typeof store & { auth?: AuthData };

        if (!bearer) {
          set.status = 401;
          set.headers["WWW-Authenticate"] =
            'Bearer realm="api", error="invalid_request"';
          throw new Error("Authorization header required");
        }

        try {
          const payload = await verifyJWT(bearer);

          if (payload.role !== "admin") {
            set.status = 403;
            set.headers["WWW-Authenticate"] =
              'Bearer realm="api", error="insufficient_scope"';
            throw new Error("Admin privileges required for this operation");
          }

          const authData: AuthData = {
            userId: payload.userId,
            username: payload.username,
            role: payload.role,
            isAdmin: true,
          };

          storeWithAuth.auth = authData;
          return { auth: authData };
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.includes("Admin privileges")
          ) {
            throw error;
          }
          logger.error("JWT verification failed", error, { context: "AUTH" });
          set.status = 401;
          set.headers["WWW-Authenticate"] =
            'Bearer realm="api", error="invalid_token"';
          throw new Error("Invalid or expired token");
        }
      },
    };
  },
});
