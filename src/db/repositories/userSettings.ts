import { db } from "../index";
import { userSettings, type NewUserSetting, type UserSetting } from "../schema";
import { and, eq, isNull } from "drizzle-orm";

export abstract class UserSettingsRepository {
  static async create(data: NewUserSetting): Promise<UserSetting> {
    const result = await db.insert(userSettings).values(data).returning();
    return result[0];
  }

  static async findByUserId(userId: string): Promise<UserSetting[]> {
    return await db
      .select()
      .from(userSettings)
      .where(
        and(eq(userSettings.userId, userId), isNull(userSettings.deletedAt)),
      );
  }

  static async findByUserAndKey(
    userId: string,
    settingKey: string,
    options?: { includeDeleted?: boolean },
  ): Promise<UserSetting | null> {
    const whereConditions = [
      eq(userSettings.userId, userId),
      eq(userSettings.settingKey, settingKey),
    ];

    if (!options?.includeDeleted) {
      whereConditions.push(isNull(userSettings.deletedAt));
    }

    const result = await db
      .select()
      .from(userSettings)
      .where(and(...whereConditions));

    return result[0] ?? null;
  }

  static async updateById(
    id: string,
    data: Partial<NewUserSetting>,
  ): Promise<UserSetting | null> {
    const result = await db
      .update(userSettings)
      .set(data)
      .where(eq(userSettings.id, id))
      .returning();

    return result[0] ?? null;
  }

  static async softDeleteById(id: string, deletedAt: Date): Promise<boolean> {
    const result = await db
      .update(userSettings)
      .set({ deletedAt })
      .where(and(eq(userSettings.id, id), isNull(userSettings.deletedAt)))
      .returning({ id: userSettings.id });

    return result.length > 0;
  }
}
