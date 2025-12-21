import { db } from "../index";
import { sessions, type NewSession, type Session } from "../schema";
import { eq, and, gt, lt, desc } from "drizzle-orm";

const SESSION_EXPIRATION_DAYS = 30;

export abstract class SessionRepository {
  static async create(
    userId: string,
    userAgent?: string,
  ): Promise<Session> {
    const id = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + SESSION_EXPIRATION_DAYS * 24 * 60 * 60 * 1000,
    );

    const session: NewSession = {
      id,
      userId,
      createdAt: now,
      lastActivityAt: now,
      expiresAt,
      userAgent: userAgent ?? null,
      isRevoked: 0,
    };

    const result = await db.insert(sessions).values(session).returning();
    return result[0];
  }

  static async findById(id: string): Promise<Session | null> {
    const result = await db.select().from(sessions).where(eq(sessions.id, id));
    return result[0] ?? null;
  }

  static async findValidById(id: string): Promise<Session | null> {
    const now = new Date();
    const result = await db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.id, id),
          eq(sessions.isRevoked, 0),
          gt(sessions.expiresAt, now),
        ),
      );
    return result[0] ?? null;
  }

  static async findByUserId(userId: string): Promise<Session[]> {
    return await db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, userId))
      .orderBy(desc(sessions.lastActivityAt));
  }

  static async updateActivity(id: string): Promise<Session | null> {
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + SESSION_EXPIRATION_DAYS * 24 * 60 * 60 * 1000,
    );

    const result = await db
      .update(sessions)
      .set({
        lastActivityAt: now,
        expiresAt,
      })
      .where(eq(sessions.id, id))
      .returning();

    return result[0] ?? null;
  }

  static async revoke(id: string): Promise<boolean> {
    const result = await db
      .update(sessions)
      .set({ isRevoked: 1 })
      .where(eq(sessions.id, id))
      .returning();

    return result.length > 0;
  }

  static async revokeAllForUser(userId: string): Promise<number> {
    const result = await db
      .update(sessions)
      .set({ isRevoked: 1 })
      .where(eq(sessions.userId, userId))
      .returning();

    return result.length;
  }

  static async deleteExpired(): Promise<number> {
    const now = new Date();
    const result = await db
      .delete(sessions)
      .where(lt(sessions.expiresAt, now))
      .returning();

    return result.length;
  }
}
