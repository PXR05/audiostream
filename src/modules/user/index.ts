import { Elysia } from "elysia";
import { authPlugin } from "../../utils/auth";
import { UserModel } from "./model";
import { UserService } from "./service";

export const userController = new Elysia({ prefix: "/user", tags: ["user"] })
  .use(authPlugin)
  .model({
    "user.settingParams": UserModel.settingParams,
    "user.upsertSetting": UserModel.upsertSettingBody,
  })

  .get(
    "/settings",
    async ({ auth }) => {
      const data = await UserService.listSettings(auth.userId);
      return { data };
    },
    {
      isAuth: true,
      response: {
        200: UserModel.settingsListResponse,
      },
    },
  )

  .guard({
    params: "user.settingParams",
  })

  .get(
    "/settings/:key",
    async ({ auth, params: { key } }) => {
      const data = await UserService.getSetting(auth.userId, key);
      return { data };
    },
    {
      isAuth: true,
      response: {
        200: UserModel.settingResponse,
        404: UserModel.errorResponse,
      },
    },
  )

  .put(
    "/settings/:key",
    async ({ auth, params: { key }, body }) => {
      const data = await UserService.upsertSetting(
        auth.userId,
        key,
        body.value,
      );
      return { data };
    },
    {
      isAuth: true,
      body: "user.upsertSetting",
      response: {
        200: UserModel.settingResponse,
        500: UserModel.errorResponse,
      },
    },
  )

  .delete(
    "/settings/:key",
    async ({ auth, params: { key } }) => {
      await UserService.deleteSetting(auth.userId, key);
      return { message: "Setting deleted successfully" };
    },
    {
      isAuth: true,
      response: {
        200: UserModel.messageResponse,
        404: UserModel.errorResponse,
        500: UserModel.errorResponse,
      },
    },
  );
