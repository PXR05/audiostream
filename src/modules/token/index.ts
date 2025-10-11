import { Elysia, t } from "elysia";
import { TokenService } from "./service";
import { authPlugin } from "../../utils/auth";

export const tokenController = new Elysia({ prefix: "/token", tags: ["token"] })
  .use(authPlugin)

  .get(
    "/check",
    async ({ bearer, set }) => {
      if (!bearer) {
        set.status = 401;
        return { error: "Token required" };
      }

      try {
        const result = await TokenService.checkToken(bearer);
        return { data: result };
      } catch (error) {
        set.status = 401;
        return { error: "Invalid token" };
      }
    },
    {
      isAuth: true,
    }
  )

  .post(
    "/",
    async ({ body }) => {
      const result = await TokenService.createToken(body.name, body.userId);
      return {
        message: "Token created successfully",
        data: result,
      };
    },
    {
      isAdmin: true,
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 255 }),
        userId: t.Optional(t.String({ minLength: 1, maxLength: 255 })),
      }),
    }
  )

  .get(
    "/",
    async ({ query }) => {
      const tokens = await TokenService.listTokens(query?.userId);
      return {
        data: tokens,
      };
    },
    {
      isAdmin: true,
      query: t.Optional(
        t.Object({
          userId: t.Optional(t.String()),
        })
      ),
    }
  )

  .delete(
    "/:id",
    async ({ params: { id }, set }) => {
      const deleted = await TokenService.deleteToken(id);
      if (!deleted) {
        set.status = 404;
        return { error: "Token not found" };
      }
      return { message: "Token deleted successfully" };
    },
    {
      isAdmin: true,
      params: t.Object({
        id: t.String(),
      }),
    }
  );
