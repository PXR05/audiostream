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
import {
  eq,
  asc,
  desc,
  sql,
  or,
  like,
  and,
  SQL,
  not,
  gt,
  inArray,
  isNull,
  isNotNull,
} from "drizzle-orm";

export abstract class PlaylistRepository {
  static async create(data: NewPlaylist): Promise<Playlist> {
    const result = await db.insert(playlists).values(data).returning();
    return result[0];
  }

  static async findAll(): Promise<Playlist[]> {
    return await db
      .select()
      .from(playlists)
      .where(isNull(playlists.deletedAt))
      .orderBy(desc(playlists.createdAt));
  }

  static async findByUserId(
    userId: string,
    type?: "artist" | "album" | "user" | "auto" | "youtube" | "tidal",
    limit?: number,
  ): Promise<(Omit<Playlist, "deletedAt"> & { itemCount: number })[]> {
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
      case "tidal":
        typeFilter = like(playlists.id, "tidal_%");
        break;
      case "user":
        typeFilter = and(
          not(like(playlists.id, "album_%")),
          not(like(playlists.id, "artist_%")),
          not(like(playlists.id, "youtube_%")),
          not(like(playlists.id, "tidal_%")),
        )!;
        break;
      case "auto":
        typeFilter = or(
          like(playlists.id, "album_%"),
          like(playlists.id, "artist_%"),
          like(playlists.id, "youtube_%"),
          like(playlists.id, "tidal_%"),
        )!;
        break;
    }

    const query = db
      .select({
        id: playlists.id,
        name: playlists.name,
        userId: playlists.userId,
        coverImage: playlists.coverImage,
        createdAt: playlists.createdAt,
        updatedAt: playlists.updatedAt,
        itemCount: sql<number>`CAST(COUNT(${playlistItems.id}) AS INTEGER)`,
      })
      .from(playlists)
      .leftJoin(
        playlistItems,
        and(
          eq(playlists.id, playlistItems.playlistId),
          isNull(playlistItems.deletedAt),
        ),
      )
      .where(and(eq(playlists.userId, userId), isNull(playlists.deletedAt), typeFilter))
      .groupBy(
        playlists.id,
        playlists.name,
        playlists.userId,
        playlists.coverImage,
        playlists.createdAt,
        playlists.updatedAt,
      )
      .orderBy(desc(playlists.updatedAt));
    if (limit) {
      query.limit(limit);
    }

    return await query;
  }

  static async findById(
    id: string,
    options?: { includeDeleted?: boolean },
  ): Promise<Playlist | null> {
    const whereConditions = [eq(playlists.id, id)];

    if (!options?.includeDeleted) {
      whereConditions.push(isNull(playlists.deletedAt));
    }

    const result = await db
      .select()
      .from(playlists)
      .where(and(...whereConditions));
    return result[0] ?? null;
  }

  static async update(
    id: string,
    data: Partial<NewPlaylist>,
  ): Promise<Playlist | null> {
    const result = await db
      .update(playlists)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(playlists.id, id), isNull(playlists.deletedAt)))
      .returning();
    return result[0] ?? null;
  }

  static async softDelete(id: string, deletedAt: Date): Promise<boolean> {
    const result = await db
      .update(playlists)
      .set({ deletedAt, updatedAt: deletedAt })
      .where(and(eq(playlists.id, id), isNull(playlists.deletedAt)))
      .returning();
    return result.length > 0;
  }

  static async restore(
    id: string,
    data?: Partial<NewPlaylist>,
  ): Promise<Playlist | null> {
    const result = await db
      .update(playlists)
      .set({
        ...data,
        deletedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(playlists.id, id))
      .returning();

    return result[0] ?? null;
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
      .where(and(eq(playlists.id, data.playlistId), isNull(playlists.deletedAt)));
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
      .innerJoin(
        audioFiles,
        and(eq(playlistItems.audioId, audioFiles.id), isNull(audioFiles.deletedAt)),
      )
      .leftJoin(
        audioFileUsers,
        and(
          eq(audioFiles.id, audioFileUsers.audioFileId),
          eq(audioFileUsers.userId, userId),
          isNull(audioFileUsers.deletedAt),
        ),
      )
      .where(
        and(
          eq(playlistItems.playlistId, playlistId),
          isNull(playlistItems.deletedAt),
          or(isNotNull(audioFileUsers.id), eq(audioFiles.isPublic, 1)),
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

  static async getDeletedItemIdsSince(
    playlistId: string,
    since: Date,
  ): Promise<string[]> {
    const rows = await db
      .select({ id: playlistItems.id })
      .from(playlistItems)
      .where(
        and(eq(playlistItems.playlistId, playlistId), gt(playlistItems.deletedAt, since)),
      );

    return rows
      .map((row) => row.id)
      .filter((id): id is string => id !== null);
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
          isNull(playlistItems.deletedAt),
        ),
      );
    return result[0] ?? null;
  }

  static async getMaxPosition(playlistId: string): Promise<number> {
    const result = await db
      .select({ maxPos: sql<number>`MAX(${playlistItems.position})` })
      .from(playlistItems)
      .where(and(eq(playlistItems.playlistId, playlistId), isNull(playlistItems.deletedAt)));
    return result[0]?.maxPos ?? -1;
  }

  static async softDeleteItem(
    playlistId: string,
    itemId: string,
    deletedAt: Date,
  ): Promise<boolean> {
    const deletedItems = await db.transaction(async (tx) => {
      const result = await tx
        .update(playlistItems)
        .set({ deletedAt })
        .where(
          and(
            eq(playlistItems.id, itemId),
            eq(playlistItems.playlistId, playlistId),
            isNull(playlistItems.deletedAt),
          ),
        )
        .returning({ id: playlistItems.id });

      if (result.length === 0) {
        return result;
      }

      await tx
        .update(playlists)
        .set({ updatedAt: deletedAt })
        .where(and(eq(playlists.id, playlistId), isNull(playlists.deletedAt)));

      return result;
    });

    return deletedItems.length > 0;
  }

  static async reorderItems(
    playlistId: string,
    itemId: string,
    newPosition: number,
  ): Promise<void> {
    const item = await db
      .select()
      .from(playlistItems)
      .where(
        and(
          eq(playlistItems.id, itemId),
          eq(playlistItems.playlistId, playlistId),
          isNull(playlistItems.deletedAt),
        ),
      );

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
            isNull(playlistItems.deletedAt),
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
            isNull(playlistItems.deletedAt),
            sql`${playlistItems.position} >= ${newPosition}`,
            sql`${playlistItems.position} < ${oldPosition}`,
          ),
        );
    }

    await db
      .update(playlistItems)
      .set({ position: newPosition })
      .where(
        and(
          eq(playlistItems.id, itemId),
          eq(playlistItems.playlistId, playlistId),
          isNull(playlistItems.deletedAt),
        ),
      );

    await db
      .update(playlists)
      .set({ updatedAt: new Date() })
      .where(and(eq(playlists.id, playlistId), isNull(playlists.deletedAt)));
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
          isNull(playlistItems.deletedAt),
        ),
      );

    await db
      .update(playlists)
      .set({ updatedAt: new Date() })
      .where(and(eq(playlists.id, playlistId), isNull(playlists.deletedAt)));
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

    await db
      .update(playlists)
      .set({ updatedAt: new Date() })
      .where(and(eq(playlists.id, playlistId), isNull(playlists.deletedAt)));
  }

  static async softDeleteItemsByPlaylist(
    playlistId: string,
    deletedAt: Date,
  ): Promise<number> {
    const result = await db
      .update(playlistItems)
      .set({ deletedAt })
      .where(
        and(
          eq(playlistItems.playlistId, playlistId),
          isNull(playlistItems.deletedAt),
        ),
      )
      .returning({ id: playlistItems.id });

    return result.length;
  }

  static async softDeleteItemsByAudio(
    audioId: string,
    deletedAt: Date,
  ): Promise<number> {
    const deletedItems = await db
      .update(playlistItems)
      .set({ deletedAt })
      .where(
        and(eq(playlistItems.audioId, audioId), isNull(playlistItems.deletedAt)),
      )
      .returning({ playlistId: playlistItems.playlistId });

    await this.touchPlaylists(
      [...new Set(deletedItems.map((item) => item.playlistId))],
      deletedAt,
    );

    return deletedItems.length;
  }

  static async softDeleteItemsByAudioForUser(
    audioId: string,
    userId: string,
    deletedAt: Date,
  ): Promise<number> {
    const userPlaylistRows = await db
      .select({ id: playlists.id })
      .from(playlists)
      .where(and(eq(playlists.userId, userId), isNull(playlists.deletedAt)));

    const playlistIds = userPlaylistRows.map((row) => row.id);
    if (playlistIds.length === 0) {
      return 0;
    }

    const deletedItems = await db
      .update(playlistItems)
      .set({ deletedAt })
      .where(
        and(
          eq(playlistItems.audioId, audioId),
          isNull(playlistItems.deletedAt),
          inArray(playlistItems.playlistId, playlistIds),
        ),
      )
      .returning({ playlistId: playlistItems.playlistId });

    await this.touchPlaylists(
      [...new Set(deletedItems.map((item) => item.playlistId))],
      deletedAt,
    );

    return deletedItems.length;
  }

  static async getDeletedIdsByUserSince(
    userId: string,
    since: Date,
  ): Promise<string[]> {
    const rows = await db
      .select({ id: playlists.id })
      .from(playlists)
      .where(and(eq(playlists.userId, userId), gt(playlists.deletedAt, since)));

    return rows.map((row) => row.id);
  }

  static async touchPlaylists(
    playlistIds: string[],
    updatedAt: Date,
  ): Promise<void> {
    if (playlistIds.length === 0) {
      return;
    }

    await db
      .update(playlists)
      .set({ updatedAt })
      .where(
        and(inArray(playlists.id, playlistIds), isNull(playlists.deletedAt)),
      );
  }
}
