import { db } from "../index";
import {
  audioFiles,
  type NewAudioFile,
  type AudioFile,
  audioFileUsers,
} from "../schema";
import { eq, asc, desc, sql, or, ilike, count, and, gt } from "drizzle-orm";
import type { AudioModel } from "../../modules/audio/model";

export abstract class AudioRepository {
  static async create(data: NewAudioFile): Promise<AudioFile> {
    const result = await db.insert(audioFiles).values(data).returning();
    return result[0];
  }

  static async findAll(options?: {
    userId?: string;
    page?: number;
    limit?: number;
    sortBy?: "id" | "filename" | "size" | "uploadedAt" | "title";
    sortOrder?: "asc" | "desc";
    lastFetchedAt?: number;
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
      const whereConditions = [
        or(eq(audioFileUsers.userId, userId), eq(audioFiles.isPublic, 1)),
      ];

      if (options?.lastFetchedAt) {
        whereConditions.push(
          gt(audioFiles.uploadedAt, new Date(options.lastFetchedAt))
        );
      }

      const userFiles = await db
        .selectDistinct({ audio_files: audioFiles })
        .from(audioFiles)
        .leftJoin(audioFileUsers, eq(audioFiles.id, audioFileUsers.audioFileId))
        .where(and(...whereConditions))
        .orderBy(orderBy)
        .limit(limit)
        .offset(offset);

      const [{ count: audioCount }] = await db
        .select({ count: count() })
        .from(audioFiles)
        .leftJoin(audioFileUsers, eq(audioFiles.id, audioFileUsers.audioFileId))
        .where(and(...whereConditions));

      return {
        files: userFiles.map((f) => f.audio_files),
        total: audioCount,
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
    userId?: string
  ): Promise<AudioFile | null> {
    if (userId) {
      const result = await db
        .select({ audio_files: audioFiles })
        .from(audioFiles)
        .leftJoin(audioFileUsers, eq(audioFiles.id, audioFileUsers.audioFileId))
        .where(
          and(
            eq(audioFiles.id, id),
            or(eq(audioFileUsers.userId, userId), eq(audioFiles.isPublic, 1))
          )
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
    data: Partial<NewAudioFile>
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
      userId: string;
    }
  ): Promise<{ files: AudioFile[]; total: number }> {
    const page = options?.page ?? 1;
    const limit = options?.limit ?? 20;
    const offset = (page - 1) * limit;
    const userId = options?.userId;
    const searchPattern = `%${query}%`;
    const lowerStartsWithPattern = `${query.toLowerCase()}%`;
    const lowerQuery = query.toLowerCase();
    const fuzzyThreshold = 0.3;

    const relevanceScore = sql<number>`(
      (CASE WHEN LOWER(${audioFiles.title}) = ${lowerQuery} THEN 150 ELSE 0 END) +
      (CASE WHEN LOWER(${audioFiles.artist}) = ${lowerQuery} THEN 120 ELSE 0 END) +
      (CASE WHEN LOWER(${audioFiles.album}) = ${lowerQuery} THEN 100 ELSE 0 END) +
      (CASE WHEN LOWER(${audioFiles.title}) LIKE ${lowerStartsWithPattern} AND LOWER(${audioFiles.title}) != ${lowerQuery} THEN 30 ELSE 0 END) +
      (CASE WHEN LOWER(${audioFiles.artist}) LIKE ${lowerStartsWithPattern} AND LOWER(${audioFiles.artist}) != ${lowerQuery} THEN 24 ELSE 0 END) +
      (CASE WHEN LOWER(${audioFiles.album}) LIKE ${lowerStartsWithPattern} AND LOWER(${audioFiles.album}) != ${lowerQuery} THEN 20 ELSE 0 END) +
      (CASE WHEN ${audioFiles.title} ILIKE ${searchPattern} AND LOWER(${audioFiles.title}) NOT LIKE ${lowerStartsWithPattern} THEN 6 ELSE 0 END) +
      (CASE WHEN ${audioFiles.artist} ILIKE ${searchPattern} AND LOWER(${audioFiles.artist}) NOT LIKE ${lowerStartsWithPattern} THEN 5 ELSE 0 END) +
      (CASE WHEN ${audioFiles.album} ILIKE ${searchPattern} AND LOWER(${audioFiles.album}) NOT LIKE ${lowerStartsWithPattern} THEN 4 ELSE 0 END) +
      (COALESCE(word_similarity(${lowerQuery}, LOWER(${audioFiles.title})), 0) * 15) +
      (COALESCE(word_similarity(${lowerQuery}, LOWER(${audioFiles.artist})), 0) * 12) +
      (COALESCE(word_similarity(${lowerQuery}, LOWER(${audioFiles.album})), 0) * 10)
    )`;

    const searchCondition = sql`(
      ${audioFiles.title} ILIKE ${searchPattern} OR
      ${audioFiles.artist} ILIKE ${searchPattern} OR
      ${audioFiles.album} ILIKE ${searchPattern} OR
      word_similarity(${lowerQuery}, LOWER(COALESCE(${audioFiles.title}, ''))) > ${fuzzyThreshold} OR
      word_similarity(${lowerQuery}, LOWER(COALESCE(${audioFiles.artist}, ''))) > ${fuzzyThreshold} OR
      word_similarity(${lowerQuery}, LOWER(COALESCE(${audioFiles.album}, ''))) > ${fuzzyThreshold}
    )`;

    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);

    if (userId) {
      const userFiles = await db
        .select({
          audio_files: audioFiles,
          _relevance: relevanceScore,
        })
        .from(audioFiles)
        .leftJoin(audioFileUsers, eq(audioFiles.id, audioFileUsers.audioFileId))
        .where(
          and(
            searchCondition,
            or(eq(audioFileUsers.userId, userId), eq(audioFiles.isPublic, 1))
          )
        )
        .groupBy(audioFiles.id)
        .orderBy(desc(relevanceScore))
        .limit(limit)
        .offset(offset);

      const countResult = await db
        .select({ count: count() })
        .from(audioFiles)
        .leftJoin(audioFileUsers, eq(audioFiles.id, audioFileUsers.audioFileId))
        .where(
          and(
            searchCondition,
            or(eq(audioFileUsers.userId, userId), eq(audioFiles.isPublic, 1))
          )
        )
        .groupBy(audioFiles.id);

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
    limit: number = 5
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
      .where(ilike(audioFiles.title, searchPattern));

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
      .where(ilike(audioFiles.artist, searchPattern));

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
      .where(ilike(audioFiles.album, searchPattern));

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
    youtubeId?: string
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
