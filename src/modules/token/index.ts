import { Elysia, t } from "elysia";
import { TokenService } from "./service";
import { authGuard } from "../../utils/auth";

export const tokenController = new Elysia({ prefix: "/token" })
  .guard(
    {
      beforeHandle: authGuard(),
    },
    (app) =>
      app.get("/check", async (context) => {
        const bearer = (context as any).bearer;
        if (!bearer) {
          context.set.status = 401;
          return { error: "Token required" };
        }

        try {
          const result = await TokenService.checkToken(bearer);
          return { data: result };
        } catch (error) {
          context.set.status = 401;
          return { error: "Invalid token" };
        }
      })
  )
  .guard(
    {
      beforeHandle: authGuard(true),
    },
    (app) =>
      app
        .post(
          "/",
          async ({ body }) => {
            const result = await TokenService.createToken(
              body.name,
              body.userId
            );
            return {
              message: "Token created successfully",
              data: result,
            };
          },
          {
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
            params: t.Object({
              id: t.String(),
            }),
          }
        )
  );
