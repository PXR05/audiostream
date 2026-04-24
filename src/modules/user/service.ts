import { status } from "elysia";
import { UserSettingsRepository } from "../../db/repositories";
import type { UserModel } from "./model";

export abstract class UserService {
  static async listSettings(userId: string): Promise<UserModel.SettingItem[]> {
    const settings = await UserSettingsRepository.findByUserId(userId);

    return settings.map((setting) => ({
      id: setting.id,
      userId: setting.userId,
      key: setting.settingKey,
      value: setting.settingValue,
      updatedAt: setting.updatedAt,
    }));
  }

  static async getSetting(
    userId: string,
    key: string,
  ): Promise<UserModel.SettingItem> {
    const setting = await UserSettingsRepository.findByUserAndKey(userId, key);

    if (!setting) {
      throw status(404, "Setting not found");
    }

    return {
      id: setting.id,
      userId: setting.userId,
      key: setting.settingKey,
      value: setting.settingValue,
      updatedAt: setting.updatedAt,
    };
  }

  static async upsertSetting(
    userId: string,
    key: string,
    value: string,
  ): Promise<UserModel.SettingItem> {
    const existing = await UserSettingsRepository.findByUserAndKey(
      userId,
      key,
      {
        includeDeleted: true,
      },
    );

    if (!existing) {
      const created = await UserSettingsRepository.create({
        id: crypto.randomUUID(),
        userId,
        settingKey: key,
        settingValue: value,
        deletedAt: null,
        updatedAt: new Date(),
      });

      return {
        id: created.id,
        userId: created.userId,
        key: created.settingKey,
        value: created.settingValue,
        updatedAt: created.updatedAt,
      };
    }

    const updated = await UserSettingsRepository.updateById(existing.id, {
      settingValue: value,
      deletedAt: null,
      updatedAt: new Date(),
    });

    if (!updated) {
      throw status(500, "Failed to update setting");
    }

    return {
      id: updated.id,
      userId: updated.userId,
      key: updated.settingKey,
      value: updated.settingValue,
      updatedAt: updated.updatedAt,
    };
  }

  static async deleteSetting(userId: string, key: string): Promise<void> {
    const existing = await UserSettingsRepository.findByUserAndKey(userId, key);

    if (!existing) {
      throw status(404, "Setting not found");
    }

    const deleted = await UserSettingsRepository.softDeleteById(
      existing.id,
      new Date(),
    );

    if (!deleted) {
      throw status(500, "Failed to delete setting");
    }
  }
}
