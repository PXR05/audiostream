import { Elysia } from "elysia";
import { bearer } from "@elysiajs/bearer";
import { logger } from "./logger";
import { validateSession } from "../modules/auth/service";

export type AuthData = {
  userId: string;
  username: string;
  role: "admin" | "user";
  isAdmin: boolean;
  sessionId: string;
};

export const authPlugin = new Elysia({ name: "auth" }).use(bearer()).macro({
  isAuth: {
    async resolve({ bearer, set }) {
      if (!bearer) {
        set.status = 401;
        set.headers["WWW-Authenticate"] =
          'Bearer realm="api", error="invalid_request"';
        throw new Error("Authorization header required");
      }

      try {
        const sessionData = await validateSession(bearer);

        if (!sessionData) {
          throw new Error("Invalid or expired session");
        }

        const authData: AuthData = {
          userId: sessionData.userId,
          username: sessionData.username,
          role: sessionData.role,
          isAdmin: sessionData.role === "admin",
          sessionId: sessionData.sessionId,
        };

        return { auth: authData };
      } catch (error) {
        logger.error("Session validation failed", error, { context: "AUTH" });
        set.status = 401;
        set.headers["WWW-Authenticate"] =
          'Bearer realm="api", error="invalid_token"';
        throw new Error("Invalid or expired session");
      }
    },
  },
  isAdmin: {
    async resolve({ bearer, set }) {
      if (!bearer) {
        set.status = 401;
        set.headers["WWW-Authenticate"] =
          'Bearer realm="api", error="invalid_request"';
        throw new Error("Authorization header required");
      }

      try {
        const sessionData = await validateSession(bearer);

        if (!sessionData) {
          throw new Error("Invalid or expired session");
        }

        if (sessionData.role !== "admin") {
          set.status = 403;
          set.headers["WWW-Authenticate"] =
            'Bearer realm="api", error="insufficient_scope"';
          throw new Error("Admin privileges required for this operation");
        }

        const authData: AuthData = {
          userId: sessionData.userId,
          username: sessionData.username,
          role: sessionData.role,
          isAdmin: true,
          sessionId: sessionData.sessionId,
        };

        return { auth: authData };
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("Admin privileges")
        ) {
          throw error;
        }
        logger.error("Session validation failed", error, { context: "AUTH" });
        set.status = 401;
        set.headers["WWW-Authenticate"] =
          'Bearer realm="api", error="invalid_token"';
        throw new Error("Invalid or expired session");
      }
    },
  },
});
