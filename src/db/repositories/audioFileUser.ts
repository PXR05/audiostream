import { db } from "../index";
import {
  audioFileUsers,
  type NewAudioFileUser,
  type AudioFileUser,
} from "../schema";
import { eq, and, gt, isNull } from "drizzle-orm";

export abstract class AudioFileUserRepository {
  static async create(data: NewAudioFileUser): Promise<AudioFileUser> {
    const result = await db.insert(audioFileUsers).values(data).returning();
    return result[0];
  }

  static async findByAudioAndUser(
    audioFileId: string,
    userId: string,
    options?: { includeDeleted?: boolean },
  ): Promise<AudioFileUser | null> {
    const whereConditions = [
      eq(audioFileUsers.audioFileId, audioFileId),
      eq(audioFileUsers.userId, userId),
    ];

    if (!options?.includeDeleted) {
      whereConditions.push(isNull(audioFileUsers.deletedAt));
    }

    const result = await db
      .select()
      .from(audioFileUsers)
      .where(and(...whereConditions));
    return result[0] ?? null;
  }

  static async findByUserId(
    userId: string,
    options?: { includeDeleted?: boolean },
  ): Promise<AudioFileUser[]> {
    const whereConditions = [eq(audioFileUsers.userId, userId)];

    if (!options?.includeDeleted) {
      whereConditions.push(isNull(audioFileUsers.deletedAt));
    }

    return await db
      .select()
      .from(audioFileUsers)
      .where(and(...whereConditions));
  }

  static async findByAudioFileId(
    audioFileId: string,
    options?: { includeDeleted?: boolean },
  ): Promise<AudioFileUser[]> {
    const whereConditions = [eq(audioFileUsers.audioFileId, audioFileId)];

    if (!options?.includeDeleted) {
      whereConditions.push(isNull(audioFileUsers.deletedAt));
    }

    return await db
      .select()
      .from(audioFileUsers)
      .where(and(...whereConditions));
  }

  static async restoreByAudioAndUser(
    audioFileId: string,
    userId: string,
  ): Promise<AudioFileUser | null> {
    const result = await db
      .update(audioFileUsers)
      .set({ deletedAt: null })
      .where(
        and(
          eq(audioFileUsers.audioFileId, audioFileId),
          eq(audioFileUsers.userId, userId),
        ),
      )
      .returning();

    return result[0] ?? null;
  }

  static async softDeleteByAudioAndUser(
    audioFileId: string,
    userId: string,
    deletedAt: Date,
  ): Promise<boolean> {
    const result = await db
      .update(audioFileUsers)
      .set({ deletedAt })
      .where(
        and(
          eq(audioFileUsers.audioFileId, audioFileId),
          eq(audioFileUsers.userId, userId),
          isNull(audioFileUsers.deletedAt),
        ),
      )
      .returning();
    return result.length > 0;
  }

  static async softDeleteByAudioFileId(
    audioFileId: string,
    deletedAt: Date,
  ): Promise<number> {
    const result = await db
      .update(audioFileUsers)
      .set({ deletedAt })
      .where(
        and(
          eq(audioFileUsers.audioFileId, audioFileId),
          isNull(audioFileUsers.deletedAt),
        ),
      )
      .returning({ id: audioFileUsers.id });

    return result.length;
  }

  static async findDeletedAudioIdsByUserSince(
    userId: string,
    since: Date,
  ): Promise<string[]> {
    const rows = await db
      .select({ audioFileId: audioFileUsers.audioFileId })
      .from(audioFileUsers)
      .where(
        and(
          eq(audioFileUsers.userId, userId),
          gt(audioFileUsers.deletedAt, since),
        ),
      );

    return rows.map((row) => row.audioFileId);
  }
}
