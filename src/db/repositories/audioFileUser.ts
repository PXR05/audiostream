import { db } from "../index";
import {
  audioFileUsers,
  type NewAudioFileUser,
  type AudioFileUser,
} from "../schema";
import { eq, and } from "drizzle-orm";

export abstract class AudioFileUserRepository {
  static async create(data: NewAudioFileUser): Promise<AudioFileUser> {
    const result = await db.insert(audioFileUsers).values(data).returning();
    return result[0];
  }

  static async findByAudioAndUser(
    audioFileId: string,
    userId: string,
  ): Promise<AudioFileUser | null> {
    const result = await db
      .select()
      .from(audioFileUsers)
      .where(
        and(
          eq(audioFileUsers.audioFileId, audioFileId),
          eq(audioFileUsers.userId, userId),
        ),
      );
    return result[0] ?? null;
  }

  static async findByUserId(userId: string): Promise<AudioFileUser[]> {
    return await db
      .select()
      .from(audioFileUsers)
      .where(eq(audioFileUsers.userId, userId));
  }

  static async findByAudioFileId(
    audioFileId: string,
  ): Promise<AudioFileUser[]> {
    return await db
      .select()
      .from(audioFileUsers)
      .where(eq(audioFileUsers.audioFileId, audioFileId));
  }

  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(audioFileUsers)
      .where(eq(audioFileUsers.id, id))
      .returning();
    return result.length > 0;
  }

  static async deleteByAudioAndUser(
    audioFileId: string,
    userId: string,
  ): Promise<boolean> {
    const result = await db
      .delete(audioFileUsers)
      .where(
        and(
          eq(audioFileUsers.audioFileId, audioFileId),
          eq(audioFileUsers.userId, userId),
        ),
      )
      .returning();
    return result.length > 0;
  }
}
