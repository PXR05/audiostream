import { db } from "../index";
import { users, type NewUser, type User } from "../schema";
import { eq, desc } from "drizzle-orm";

export abstract class UserRepository {
  static async create(data: NewUser): Promise<User> {
    const result = await db.insert(users).values(data).returning();
    return result[0];
  }

  static async findAll(): Promise<User[]> {
    return await db.select().from(users).orderBy(desc(users.createdAt));
  }

  static async findById(id: string): Promise<User | null> {
    const result = await db.select().from(users).where(eq(users.id, id));
    return result[0] ?? null;
  }

  static async findByUsername(username: string): Promise<User | null> {
    const result = await db
      .select()
      .from(users)
      .where(eq(users.username, username));
    return result[0] ?? null;
  }

  static async update(
    id: string,
    data: Partial<NewUser>,
  ): Promise<User | null> {
    const result = await db
      .update(users)
      .set(data)
      .where(eq(users.id, id))
      .returning();
    return result[0] ?? null;
  }

  static async updateLastLogin(id: string): Promise<void> {
    await db
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, id));
  }

  static async delete(id: string): Promise<boolean> {
    const result = await db.delete(users).where(eq(users.id, id)).returning();
    return result.length > 0;
  }
}
