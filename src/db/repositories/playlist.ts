import { db } from "../index";
import {
  playlists,
  type NewPlaylist,
  type Playlist,
  playlistItems,
  type NewPlaylistItem,
  type PlaylistItem,
  audioFiles,
  type AudioFile,
  audioFileUsers,
} from "../schema";
import { eq, asc, desc, sql, or, like, and, SQL, not } from "drizzle-orm";

export abstract class PlaylistRepository {
  static async create(data: NewPlaylist): Promise<Playlist> {
    const result = await db.insert(playlists).values(data).returning();
    return result[0];
  }

  static async findAll(): Promise<Playlist[]> {
    return await db.select().from(playlists).orderBy(desc(playlists.createdAt));
  }

  static async findByUserId(
    userId: string,
    type?: "artist" | "album" | "user" | "auto" | "youtube",
    limit?: number,
  ): Promise<Playlist[]> {
    let typeFilter: SQL | undefined;
    switch (type) {
      case "artist":
        typeFilter = like(playlists.id, "artist_%");
        break;
      case "album":
        typeFilter = like(playlists.id, "album_%");
        break;
      case "youtube":
        typeFilter = like(playlists.id, "youtube_%");
        break;
      case "user":
        typeFilter = and(
          not(like(playlists.id, "album_%")),
          not(like(playlists.id, "artist_%")),
          not(like(playlists.id, "youtube_%")),
        )!;
        break;
      case "auto":
        typeFilter = or(
          like(playlists.id, "album_%"),
          like(playlists.id, "artist_%"),
          like(playlists.id, "youtube_%"),
        )!;
        break;
    }

    const query = db
      .select()
      .from(playlists)
      .where(and(eq(playlists.userId, userId), typeFilter))
      .orderBy(desc(playlists.createdAt));
    if (limit) {
      query.limit(limit);
    }

    return await query;
  }

  static async findById(id: string): Promise<Playlist | null> {
    const result = await db
      .select()
      .from(playlists)
      .where(eq(playlists.id, id));
    return result[0] ?? null;
  }

  static async update(
    id: string,
    data: Partial<NewPlaylist>,
  ): Promise<Playlist | null> {
    const result = await db
      .update(playlists)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(playlists.id, id))
      .returning();
    return result[0] ?? null;
  }

  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(playlists)
      .where(eq(playlists.id, id))
      .returning();
    return result.length > 0;
  }

  static async addItem(data: NewPlaylistItem): Promise<PlaylistItem> {
    const result = await db.transaction(async (tx) => {
      const trackInsert = await tx
        .insert(playlistItems)
        .values(data)
        .returning();
      await tx
        .update(playlists)
        .set({ updatedAt: data.addedAt })
        .where(eq(playlists.id, data.playlistId));
      return trackInsert;
    });
    return result[0];
  }

  static async getItems(
    playlistId: string,
    userId: string,
  ): Promise<
    Array<{
      item: PlaylistItem;
      audio: AudioFile;
    }>
  > {
    const items = await db
      .select()
      .from(playlistItems)
      .innerJoin(audioFiles, eq(playlistItems.audioId, audioFiles.id))
      .innerJoin(audioFileUsers, eq(audioFiles.id, audioFileUsers.audioFileId))
      .where(
        and(
          or(eq(audioFileUsers.userId, userId), eq(audioFiles.isPublic, 1)),
          eq(playlistItems.playlistId, playlistId),
        ),
      )
      .orderBy(asc(playlistItems.position));

    return items
      .filter((item) => item.audio_files !== null)
      .map((item) => ({
        item: item.playlist_items,
        audio: item.audio_files!,
      }));
  }

  static async removeItem(id: string): Promise<boolean> {
    const result = await db
      .delete(playlistItems)
      .where(eq(playlistItems.id, id))
      .returning();
    return result.length > 0;
  }

  static async findItemByAudioAndPlaylist(
    playlistId: string,
    audioId: string,
  ): Promise<PlaylistItem | null> {
    const result = await db
      .select()
      .from(playlistItems)
      .where(
        and(
          eq(playlistItems.playlistId, playlistId),
          eq(playlistItems.audioId, audioId),
        ),
      );
    return result[0] ?? null;
  }

  static async getMaxPosition(playlistId: string): Promise<number> {
    const result = await db
      .select({ maxPos: sql<number>`MAX(${playlistItems.position})` })
      .from(playlistItems)
      .where(eq(playlistItems.playlistId, playlistId));
    return result[0]?.maxPos ?? -1;
  }

  static async reorderItems(
    playlistId: string,
    itemId: string,
    newPosition: number,
  ): Promise<void> {
    const item = await db
      .select()
      .from(playlistItems)
      .where(eq(playlistItems.id, itemId));

    if (!item[0]) return;

    const oldPosition = item[0].position;

    if (oldPosition === newPosition) return;

    if (oldPosition < newPosition) {
      await db
        .update(playlistItems)
        .set({ position: sql`${playlistItems.position} - 1` })
        .where(
          and(
            eq(playlistItems.playlistId, playlistId),
            sql`${playlistItems.position} > ${oldPosition}`,
            sql`${playlistItems.position} <= ${newPosition}`,
          ),
        );
    } else {
      await db
        .update(playlistItems)
        .set({ position: sql`${playlistItems.position} + 1` })
        .where(
          and(
            eq(playlistItems.playlistId, playlistId),
            sql`${playlistItems.position} >= ${newPosition}`,
            sql`${playlistItems.position} < ${oldPosition}`,
          ),
        );
    }

    await db
      .update(playlistItems)
      .set({ position: newPosition })
      .where(eq(playlistItems.id, itemId));
  }

  static async updateItemPosition(
    playlistId: string,
    audioId: string,
    newPosition: number,
  ): Promise<void> {
    await db
      .update(playlistItems)
      .set({ position: newPosition })
      .where(
        and(
          eq(playlistItems.playlistId, playlistId),
          eq(playlistItems.audioId, audioId),
        ),
      );
  }

  static async reorderAllItems(
    playlistId: string,
    positionMap: Map<string, { audioId: string; position: number }>,
  ): Promise<void> {
    const valuesToUpdate = Array.from(positionMap.entries()).map(
      ([playlistItemId, { audioId, position }]) => ({
        id: playlistItemId,
        audioId,
        playlistId,
        position,
      }),
    );
    await db
      .insert(playlistItems)
      .values(valuesToUpdate)
      .onConflictDoUpdate({
        target: [playlistItems.audioId, playlistItems.playlistId],
        set: {
          position: sql`excluded.position`,
        },
      });
  }
}
