import { db } from "./index";
import {
  audioFiles,
  type NewAudioFile,
  type AudioFile,
  users,
  type NewUser,
  type User,
  playlists,
  type NewPlaylist,
  type Playlist,
  playlistItems,
  type NewPlaylistItem,
  type PlaylistItem,
  audioFileUsers,
  type NewAudioFileUser,
  type AudioFileUser,
} from "./schema";
import {
  eq,
  asc,
  desc,
  sql,
  or,
  like,
  count,
  and,
  SQL,
  not,
} from "drizzle-orm";
import type { AudioModel } from "../modules/audio/model";

export abstract class AudioRepository {
  static async create(data: NewAudioFile): Promise<AudioFile> {
    const result = await db.insert(audioFiles).values(data).returning();
    return result[0];
  }

  static async findAll(options?: {
    page?: number;
    limit?: number;
    sortBy?: "id" | "filename" | "size" | "uploadedAt" | "title";
    sortOrder?: "asc" | "desc";
    userId?: string;
  }): Promise<{ files: AudioFile[]; total: number }> {
    const page = options?.page ?? 1;
    const limit = options?.limit ?? 20;
    const offset = (page - 1) * limit;
    const sortBy = options?.sortBy ?? "uploadedAt";
    const sortOrder = options?.sortOrder ?? "desc";
    const userId = options?.userId;

    let orderByColumn;
    switch (sortBy) {
      case "id":
        orderByColumn = audioFiles.id;
        break;
      case "filename":
        orderByColumn = audioFiles.filename;
        break;
      case "size":
        orderByColumn = audioFiles.size;
        break;
      case "title":
        orderByColumn = audioFiles.title;
        break;
      case "uploadedAt":
      default:
        orderByColumn = audioFiles.uploadedAt;
        break;
    }

    const orderBy =
      sortOrder === "asc" ? asc(orderByColumn) : desc(orderByColumn);

    if (userId) {
      const userFiles = await db
        .selectDistinct({ audio_files: audioFiles })
        .from(audioFiles)
        .leftJoin(audioFileUsers, eq(audioFiles.id, audioFileUsers.audioFileId))
        .where(
          or(eq(audioFileUsers.userId, userId), eq(audioFiles.isPublic, 1)),
        )
        .orderBy(orderBy)
        .limit(limit)
        .offset(offset);

      const countResult = await db
        .selectDistinct({ audio_files: audioFiles })
        .from(audioFiles)
        .leftJoin(audioFileUsers, eq(audioFiles.id, audioFileUsers.audioFileId))
        .where(
          or(eq(audioFileUsers.userId, userId), eq(audioFiles.isPublic, 1)),
        );

      return {
        files: userFiles.map((f) => f.audio_files),
        total: countResult.length,
      };
    }

    const files = await db
      .select()
      .from(audioFiles)
      .orderBy(orderBy)
      .limit(limit)
      .offset(offset);

    const countResult = await db.select({ count: count() }).from(audioFiles);
    const total = countResult[0]?.count ?? 0;

    return { files, total };
  }

  static async findById(
    id: string,
    userId?: string,
  ): Promise<AudioFile | null> {
    if (userId) {
      const result = await db
        .select({ audio_files: audioFiles })
        .from(audioFiles)
        .leftJoin(audioFileUsers, eq(audioFiles.id, audioFileUsers.audioFileId))
        .where(
          and(
            eq(audioFiles.id, id),
            or(eq(audioFileUsers.userId, userId), eq(audioFiles.isPublic, 1)),
          ),
        );

      return result[0]?.audio_files ?? null;
    }

    const result = await db
      .select()
      .from(audioFiles)
      .where(eq(audioFiles.id, id));
    return result[0] ?? null;
  }

  static async findByFilename(filename: string): Promise<AudioFile | null> {
    const result = await db
      .select()
      .from(audioFiles)
      .where(eq(audioFiles.filename, filename));
    return result[0] ?? null;
  }

  static async findByYoutubeId(videoId: string): Promise<AudioFile | null> {
    const result = await db
      .select()
      .from(audioFiles)
      .where(eq(audioFiles.youtubeId, videoId));
    return result[0] ?? null;
  }

  static async update(
    id: string,
    data: Partial<NewAudioFile>,
  ): Promise<AudioFile | null> {
    const result = await db
      .update(audioFiles)
      .set(data)
      .where(eq(audioFiles.id, id))
      .returning();
    return result[0] ?? null;
  }

  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(audioFiles)
      .where(eq(audioFiles.id, id))
      .returning();
    return result.length > 0;
  }

  static async search(
    query: string,
    options?: {
      page?: number;
      limit?: number;
      userId?: string;
    },
  ): Promise<{ files: AudioFile[]; total: number }> {
    const page = options?.page ?? 1;
    const limit = options?.limit ?? 20;
    const offset = (page - 1) * limit;
    const userId = options?.userId;
    const searchPattern = `%${query}%`;
    const startsWithPattern = `${query}%`;
    const lowerQuery = query.toLowerCase();

    const relevanceScore = sql<number>`
      CASE
        WHEN LOWER(${audioFiles.title}) = ${lowerQuery} THEN 4000
        WHEN LOWER(${audioFiles.artist}) = ${lowerQuery} THEN 3000
        WHEN LOWER(${audioFiles.album}) = ${lowerQuery} THEN 2000
        WHEN LOWER(${audioFiles.filename}) = ${lowerQuery} THEN 1000
        WHEN LOWER(${audioFiles.title}) LIKE ${startsWithPattern} THEN 400
        WHEN LOWER(${audioFiles.artist}) LIKE ${startsWithPattern} THEN 300
        WHEN LOWER(${audioFiles.album}) LIKE ${startsWithPattern} THEN 200
        WHEN LOWER(${audioFiles.filename}) LIKE ${startsWithPattern} THEN 100
        WHEN ${audioFiles.title} LIKE ${searchPattern} THEN 40
        WHEN ${audioFiles.artist} LIKE ${searchPattern} THEN 30
        WHEN ${audioFiles.album} LIKE ${searchPattern} THEN 20
        WHEN ${audioFiles.filename} LIKE ${searchPattern} THEN 10
        ELSE 0
      END
    `;

    const searchCondition = or(
      like(audioFiles.title, searchPattern),
      like(audioFiles.artist, searchPattern),
      like(audioFiles.album, searchPattern),
      like(audioFiles.filename, searchPattern),
    );

    if (userId) {
      const userFiles = await db
        .selectDistinct({ audio_files: audioFiles })
        .from(audioFiles)
        .leftJoin(audioFileUsers, eq(audioFiles.id, audioFileUsers.audioFileId))
        .where(
          and(
            searchCondition,
            or(eq(audioFileUsers.userId, userId), eq(audioFiles.isPublic, 1)),
          ),
        )
        .orderBy(desc(relevanceScore))
        .limit(limit)
        .offset(offset);

      const countResult = await db
        .selectDistinct({ audio_files: audioFiles })
        .from(audioFiles)
        .leftJoin(audioFileUsers, eq(audioFiles.id, audioFileUsers.audioFileId))
        .where(
          and(
            searchCondition,
            or(eq(audioFileUsers.userId, userId), eq(audioFiles.isPublic, 1)),
          ),
        );

      return {
        files: userFiles.map((f) => f.audio_files),
        total: countResult.length,
      };
    }

    const files = await db
      .select()
      .from(audioFiles)
      .where(searchCondition)
      .orderBy(desc(relevanceScore))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(audioFiles)
      .where(searchCondition);

    const total = countResult[0]?.count ?? 0;

    return { files, total };
  }

  static async searchSuggestions(
    query: string,
    limit: number = 5,
  ): Promise<AudioModel.searchSuggestion[]> {
    const searchPattern = `%${query}%`;
    const startsWithPattern = `${query}%`;
    const lowerQuery = query.toLowerCase();

    const titleQuery = db
      .selectDistinct({
        type: sql<string>`'title'`.as("type"),
        value: audioFiles.title,
        score: sql<number>`
          CASE
            WHEN LOWER(${audioFiles.title}) = ${lowerQuery} THEN 4000
            WHEN LOWER(${audioFiles.title}) LIKE ${startsWithPattern} THEN 400
            ELSE 40
          END
        `.as("score"),
      })
      .from(audioFiles)
      .where(like(audioFiles.title, searchPattern));

    const artistQuery = db
      .selectDistinct({
        type: sql<string>`'artist'`.as("type"),
        value: audioFiles.artist,
        score: sql<number>`
          CASE
            WHEN LOWER(${audioFiles.artist}) = ${lowerQuery} THEN 3000
            WHEN LOWER(${audioFiles.artist}) LIKE ${startsWithPattern} THEN 300
            ELSE 30
          END
        `.as("score"),
      })
      .from(audioFiles)
      .where(like(audioFiles.artist, searchPattern));

    const albumQuery = db
      .selectDistinct({
        type: sql<string>`'album'`.as("type"),
        value: audioFiles.album,
        score: sql<number>`
          CASE
            WHEN LOWER(${audioFiles.album}) = ${lowerQuery} THEN 2000
            WHEN LOWER(${audioFiles.album}) LIKE ${startsWithPattern} THEN 200
            ELSE 20
          END
        `.as("score"),
      })
      .from(audioFiles)
      .where(like(audioFiles.album, searchPattern));

    const results = await titleQuery
      .unionAll(artistQuery)
      .unionAll(albumQuery)
      .orderBy(desc(sql.raw("score")));

    const seen = new Set<string>();
    const suggestions: AudioModel.searchSuggestion[] = [];

    for (const result of results) {
      if (result.value && !seen.has(result.value)) {
        suggestions.push({
          type: result.type as "title" | "artist" | "album",
          value: result.value,
          score: result.score,
        });
        seen.add(result.value);

        if (suggestions.length >= limit) break;
      }
    }

    return suggestions;
  }

  static toAudioModel(dbFile: AudioFile): AudioModel.audioFile {
    return {
      id: dbFile.id,
      filename: dbFile.filename,
      size: dbFile.size,
      uploadedAt: dbFile.uploadedAt,
      imageFile: dbFile.imageFile ?? undefined,
      youtubeId: dbFile.youtubeId ?? undefined,
      metadata: {
        title: dbFile.title ?? undefined,
        artist: dbFile.artist ?? undefined,
        album: dbFile.album ?? undefined,
        year: dbFile.year ?? undefined,
        genre: dbFile.genre ? JSON.parse(dbFile.genre) : undefined,
        duration: dbFile.duration ?? undefined,
        bitrate: dbFile.bitrate ?? undefined,
        sampleRate: dbFile.sampleRate ?? undefined,
        channels: dbFile.channels ?? undefined,
        format: dbFile.format ?? undefined,
      },
    };
  }

  static fromMetadata(
    id: string,
    filename: string,
    size: number,
    metadata?: AudioModel.audioMetadata,
    imageFile?: string,
    youtubeId?: string,
  ): NewAudioFile {
    return {
      id,
      youtubeId,
      filename,
      size,
      uploadedAt: new Date(),
      imageFile: imageFile ?? null,
      title: metadata?.title ?? null,
      artist: metadata?.artist ?? null,
      album: metadata?.album ?? null,
      year: metadata?.year ?? null,
      genre: metadata?.genre ? JSON.stringify(metadata.genre) : null,
      duration: metadata?.duration ?? null,
      bitrate: metadata?.bitrate ?? null,
      sampleRate: metadata?.sampleRate ?? null,
      channels: metadata?.channels ?? null,
      format: metadata?.format ?? null,
    };
  }
}

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
        typeFilter = like(playlists.id, "%artist_%");
        break;
      case "album":
        typeFilter = like(playlists.id, "%album_%");
        break;
      case "youtube":
        typeFilter = like(playlists.id, "youtube_%");
        break;
      case "user":
        typeFilter = and(
          not(like(playlists.id, "%album_%")),
          not(like(playlists.id, "%artist_%")),
          not(like(playlists.id, "youtube_%")),
        )!;
        break;
      case "auto":
        typeFilter = or(
          like(playlists.id, "%album_%"),
          like(playlists.id, "%artist_%"),
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

  static async getItems(playlistId: string): Promise<
    Array<{
      item: PlaylistItem;
      audio: AudioFile;
    }>
  > {
    const items = await db
      .select()
      .from(playlistItems)
      .leftJoin(audioFiles, eq(playlistItems.audioId, audioFiles.id))
      .where(eq(playlistItems.playlistId, playlistId))
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
}

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
