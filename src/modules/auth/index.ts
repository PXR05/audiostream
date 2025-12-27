import { Elysia } from "elysia";
import { AuthService } from "./service";
import { AuthModel } from "./model";
import {
  authPlugin,
  SESSION_COOKIE_NAME,
  getSessionCookieOptions,
} from "../../utils/auth";

export const authController = new Elysia({ prefix: "/auth", tags: ["auth"] })
  .model({
    "auth.register": AuthModel.registerBody,
    "auth.login": AuthModel.loginBody,
    "auth.changePassword": AuthModel.changePasswordBody,
    "auth.userParams": AuthModel.userParams,
  })

  .post(
    "/register",
    async ({ body, set, request, cookie }) => {
      try {
        const userAgent = request.headers.get("user-agent") ?? undefined;
        const result = await AuthService.register(
          body.username,
          body.password,
          "user",
          userAgent
        );

        cookie[SESSION_COOKIE_NAME].set(
          getSessionCookieOptions(result.sessionId)
        );

        return {
          message: result.message,
          user: result.user,
        };
      } catch (error) {
        set.status = 400;
        return {
          error: error instanceof Error ? error.message : "Registration failed",
        };
      }
    },
    {
      body: "auth.register",
      response: {
        200: AuthModel.authResponse,
        400: AuthModel.errorResponse,
      },
    }
  )

  .post(
    "/login",
    async ({ body, set, request, cookie }) => {
      try {
        const userAgent = request.headers.get("user-agent") ?? undefined;
        const result = await AuthService.login(
          body.username,
          body.password,
          userAgent
        );

        cookie[SESSION_COOKIE_NAME].set(
          getSessionCookieOptions(result.sessionId)
        );

        return {
          message: result.message,
          user: result.user,
        };
      } catch (error) {
        set.status = 401;
        return {
          error: error instanceof Error ? error.message : "Login failed",
        };
      }
    },
    {
      body: "auth.login",
      response: {
        200: AuthModel.authResponse,
        401: AuthModel.errorResponse,
      },
    }
  )

  .use(authPlugin)

  .get(
    "/me",
    async ({ auth, set }) => {
      const user = await AuthService.getUserInfo(auth.userId);
      if (!user) {
        set.status = 404;
        return { error: "User not found" };
      }

      return { data: user };
    },
    {
      isAuth: true,
      response: {
        200: AuthModel.meResponse,
        404: AuthModel.errorResponse,
      },
    }
  )

  .post(
    "/change-password",
    async ({ body, set, auth }) => {
      try {
        await AuthService.changePassword(
          auth.userId,
          body.currentPassword,
          body.newPassword
        );
        return { message: "Password changed successfully" };
      } catch (error) {
        set.status = 400;
        return {
          error:
            error instanceof Error ? error.message : "Password change failed",
        };
      }
    },
    {
      isAuth: true,
      body: "auth.changePassword",
      response: {
        200: AuthModel.messageResponse,
        400: AuthModel.errorResponse,
      },
    }
  )

  .get(
    "/users",
    async () => {
      const users = await AuthService.listUsers();
      return { data: users };
    },
    {
      isAdmin: true,
      response: {
        200: AuthModel.usersListResponse,
      },
    }
  )

  .delete(
    "/users/:id",
    async ({ params: { id }, set }) => {
      const deleted = await AuthService.deleteUser(id);
      if (!deleted) {
        set.status = 404;
        return { error: "User not found" };
      }
      return { message: "User deleted successfully" };
    },
    {
      isAdmin: true,
      params: "auth.userParams",
      response: {
        200: AuthModel.messageResponse,
        404: AuthModel.errorResponse,
      },
    }
  )

  .post(
    "/logout",
    async ({ auth, set }) => {
      try {
        const result = await AuthService.logout(auth.sessionId);
        return result;
      } catch (error) {
        set.status = 400;
        return {
          error: error instanceof Error ? error.message : "Logout failed",
        };
      }
    },
    {
      isAuth: true,
      response: {
        200: AuthModel.messageResponse,
        400: AuthModel.errorResponse,
      },
    }
  )

  .post(
    "/logout-all",
    async ({ auth }) => {
      const count = await AuthService.revokeAllSessions(auth.userId);
      return { message: `Logged out from ${count} sessions` };
    },
    {
      isAuth: true,
      response: {
        200: AuthModel.messageResponse,
      },
    }
  )

  .get(
    "/sessions",
    async ({ auth }) => {
      const sessions = await AuthService.getUserSessions(auth.userId);
      return { data: sessions };
    },
    {
      isAuth: true,
      response: {
        200: AuthModel.sessionsListResponse,
      },
    }
  );
