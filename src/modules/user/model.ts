import { t } from "elysia";

export namespace UserModel {
  export const settingParams = t.Object({
    key: t.String({ minLength: 1 }),
  });

  export const upsertSettingBody = t.Object({
    value: t.String({ minLength: 1 }),
  });

  export const settingItem = t.Object({
    id: t.String(),
    userId: t.String(),
    key: t.String(),
    value: t.String(),
    updatedAt: t.Date(),
  });

  export const settingsListResponse = t.Object({
    data: t.Array(settingItem),
  });

  export const settingResponse = t.Object({
    data: settingItem,
  });

  export const messageResponse = t.Object({
    message: t.String(),
  });

  export const errorResponse = t.Object({
    error: t.String(),
  });

  export type SettingItem = typeof settingItem.static;
}
