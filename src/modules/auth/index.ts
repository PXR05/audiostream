import { Elysia, t } from "elysia";
import { AuthService } from "./service";
import { authPlugin, type AuthData } from "../../utils/auth";

export const authController = new Elysia({ prefix: "/auth", tags: ["auth"] })
  .post(
    "/register",
    async ({ body, set }) => {
      try {
        const result = await AuthService.register(body.username, body.password);
        return result;
      } catch (error) {
        set.status = 400;
        return {
          error: error instanceof Error ? error.message : "Registration failed",
        };
      }
    },
    {
      body: t.Object({
        username: t.String({ minLength: 3, maxLength: 50 }),
        password: t.String({ minLength: 6 }),
      }),
    },
  )

  .post(
    "/login",
    async ({ body, set }) => {
      try {
        const result = await AuthService.login(body.username, body.password);
        return result;
      } catch (error) {
        set.status = 401;
        return {
          error: error instanceof Error ? error.message : "Login failed",
        };
      }
    },
    {
      body: t.Object({
        username: t.String(),
        password: t.String(),
      }),
    },
  )

  .use(authPlugin)

  .get(
    "/me",
    async ({ store, set }) => {
      const storeWithAuth = store as typeof store & { auth?: AuthData };
      if (!storeWithAuth.auth) {
        set.status = 401;
        return { error: "Unauthorized" };
      }

      const user = await AuthService.getUserInfo(storeWithAuth.auth.userId);
      if (!user) {
        set.status = 404;
        return { error: "User not found" };
      }

      return { data: user };
    },
    {
      isAuth: true,
    },
  )

  .post(
    "/change-password",
    async ({ store, body, set }) => {
      const storeWithAuth = store as typeof store & { auth?: AuthData };
      if (!storeWithAuth.auth) {
        set.status = 401;
        return { error: "Unauthorized" };
      }

      try {
        await AuthService.changePassword(
          storeWithAuth.auth.userId,
          body.currentPassword,
          body.newPassword,
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
      body: t.Object({
        currentPassword: t.String(),
        newPassword: t.String({ minLength: 6 }),
      }),
    },
  )

  .get(
    "/users",
    async () => {
      const users = await AuthService.listUsers();
      return { data: users };
    },
    {
      isAdmin: true,
    },
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
      params: t.Object({
        id: t.String(),
      }),
    },
  );
