import { Elysia } from "elysia";
import { logger } from "./logger";
import { validateSession } from "../modules/auth/service";

export type AuthData = {
  userId: string;
  username: string;
  role: "admin" | "user";
  isAdmin: boolean;
  sessionId: string;
};

export const SESSION_COOKIE_NAME = "auth_session";
export const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export const getSessionCookieOptions = (sessionId: string) => ({
  value: sessionId,
  httpOnly: true,
  secure: true,
  sameSite: "none" as const,
  path: "/",
  maxAge: SESSION_COOKIE_MAX_AGE,
});

export const authPlugin = new Elysia({ name: "auth" }).macro({
  isAuth: {
    async resolve({ set, cookie }) {
      const sessionId = cookie[SESSION_COOKIE_NAME].cookie.value;

      if (
        !sessionId ||
        typeof sessionId !== "string" ||
        sessionId.length === 0
      ) {
        set.status = 401;
        set.headers["WWW-Authenticate"] =
          'Bearer realm="api", error="invalid_request"';
        throw new Error("Session cookie required");
      }

      try {
        const sessionData = await validateSession(sessionId);

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
    async resolve({ set, cookie }) {
      const sessionId = cookie[SESSION_COOKIE_NAME].cookie.value;

      if (
        !sessionId ||
        typeof sessionId !== "string" ||
        sessionId.length === 0
      ) {
        set.status = 401;
        set.headers["WWW-Authenticate"] =
          'Bearer realm="api", error="invalid_request"';
        throw new Error("Session cookie required");
      }

      try {
        const sessionData = await validateSession(sessionId);

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
