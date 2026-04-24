import { db } from "../index";
import {
  audioFiles,
  type NewAudioFile,
  type AudioFile,
  audioFileUsers,
} from "../schema";
import {
  eq,
  asc,
  desc,
  sql,
  or,
  ilike,
  count,
  and,
  gt,
  isNull,
} from "drizzle-orm";
import type { AudioModel } from "../../modules/audio/model";
import { normalizeIsrc } from "../../utils/isrc";

export abstract class AudioRepository {
  private static activeAudioCondition = isNull(audioFiles.deletedAt);

  private static activeUserAccessCondition(userId: string) {
    return or(
      and(eq(audioFileUsers.userId, userId), isNull(audioFileUsers.deletedAt)),
      eq(audioFiles.isPublic, 1),
    )!;
  }

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
    artist?: string;
    album?: string;
    genre?: string;
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
        this.activeAudioCondition,
        this.activeUserAccessCondition(userId),
      ];

      if (options?.lastFetchedAt) {
        whereConditions.push(
          gt(audioFiles.updatedAt, new Date(options.lastFetchedAt)),
        );
      }

      if (options?.artist) {
        whereConditions.push(ilike(audioFiles.artist, `%${options.artist}%`));
      }

      if (options?.album) {
        whereConditions.push(ilike(audioFiles.album, `%${options.album}%`));
      }

      if (options?.genre) {
        whereConditions.push(ilike(audioFiles.genre, `%${options.genre}%`));
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
      .where(this.activeAudioCondition)
      .orderBy(orderBy)
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(audioFiles)
      .where(this.activeAudioCondition);
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
            this.activeAudioCondition,
            this.activeUserAccessCondition(userId),
          ),
        );

      return result[0]?.audio_files ?? null;
    }

    const result = await db
      .select()
      .from(audioFiles)
      .where(and(eq(audioFiles.id, id), this.activeAudioCondition));
    return result[0] ?? null;
  }

  static async findByFilename(filename: string): Promise<AudioFile | null> {
    const result = await db
      .select()
      .from(audioFiles)
      .where(and(eq(audioFiles.filename, filename), this.activeAudioCondition));
    return result[0] ?? null;
  }

  static async findByTidalId(tidalId: string): Promise<AudioFile | null> {
    const result = await db
      .select()
      .from(audioFiles)
      .where(and(eq(audioFiles.tidalId, tidalId), this.activeAudioCondition));
    return result[0] ?? null;
  }

  static async findByYoutubeId(videoId: string): Promise<AudioFile | null> {
    const result = await db
      .select()
      .from(audioFiles)
      .where(and(eq(audioFiles.youtubeId, videoId), this.activeAudioCondition));
    return result[0] ?? null;
  }

  static async findByIsrc(isrc: string): Promise<AudioFile | null> {
    const normalized = normalizeIsrc(isrc);
    if (!normalized) return null;

    const result = await db
      .select()
      .from(audioFiles)
      .where(and(eq(audioFiles.isrc, normalized), this.activeAudioCondition));
    return result[0] ?? null;
  }

  static async update(
    id: string,
    data: Partial<NewAudioFile>,
  ): Promise<AudioFile | null> {
    const result = await db
      .update(audioFiles)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(audioFiles.id, id))
      .returning();
    return result[0] ?? null;
  }

  static async softDelete(id: string, deletedAt: Date): Promise<boolean> {
    const result = await db
      .update(audioFiles)
      .set({ deletedAt })
      .where(and(eq(audioFiles.id, id), this.activeAudioCondition))
      .returning();
    return result.length > 0;
  }

  static async search(
    query: string,
    options?: {
      page?: number;
      limit?: number;
      userId: string;
    },
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
            this.activeAudioCondition,
            searchCondition,
            this.activeUserAccessCondition(userId),
          ),
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
            this.activeAudioCondition,
            searchCondition,
            this.activeUserAccessCondition(userId),
          ),
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
      .where(and(this.activeAudioCondition, searchCondition))
      .orderBy(desc(relevanceScore))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(audioFiles)
      .where(and(this.activeAudioCondition, searchCondition));

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
      .where(
        and(this.activeAudioCondition, ilike(audioFiles.title, searchPattern)),
      );

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
      .where(
        and(this.activeAudioCondition, ilike(audioFiles.artist, searchPattern)),
      );

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
      .where(
        and(this.activeAudioCondition, ilike(audioFiles.album, searchPattern)),
      );

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

  static async findDeletedIdsSince(
    userId: string,
    since: Date,
  ): Promise<string[]> {
    const [deletedFiles, deletedUserLinks] = await Promise.all([
      db
        .selectDistinct({ id: audioFiles.id })
        .from(audioFiles)
        .leftJoin(audioFileUsers, eq(audioFiles.id, audioFileUsers.audioFileId))
        .where(
          and(
            gt(audioFiles.deletedAt, since),
            or(eq(audioFiles.isPublic, 1), eq(audioFileUsers.userId, userId)),
          ),
        ),
      db
        .selectDistinct({ id: audioFileUsers.audioFileId })
        .from(audioFileUsers)
        .where(
          and(
            eq(audioFileUsers.userId, userId),
            gt(audioFileUsers.deletedAt, since),
          ),
        ),
    ]);

    return [
      ...new Set([...deletedFiles, ...deletedUserLinks].map((row) => row.id)),
    ];
  }

  static toAudioModel(dbFile: AudioFile): AudioModel.audioFile {
    return {
      id: dbFile.id,
      filename: dbFile.filename,
      size: dbFile.size,
      updatedAt: dbFile.updatedAt,
      uploadedAt: dbFile.uploadedAt,
      imageFile: dbFile.imageFile ?? undefined,
      youtubeId: dbFile.youtubeId ?? undefined,
      tidalId: dbFile.tidalId ?? undefined,
      isrc: dbFile.isrc ?? undefined,
      metadata: {
        title: dbFile.title ?? undefined,
        artist: dbFile.artist ?? undefined,
        album: dbFile.album ?? undefined,
        isrc: dbFile.isrc ?? undefined,
        year: dbFile.year ?? undefined,
        genre: dbFile.genre ? JSON.parse(dbFile.genre) : undefined,
        duration: dbFile.duration ?? undefined,
        bitrate: dbFile.bitrate ?? undefined,
        sampleRate: dbFile.sampleRate ?? undefined,
        bitDepth: dbFile.bitDepth ?? undefined,
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
    tidalId?: string,
    isrc?: string,
  ): NewAudioFile {
    const normalizedIsrc = normalizeIsrc(isrc ?? metadata?.isrc);

    return {
      id,
      youtubeId,
      tidalId,
      isrc: normalizedIsrc ?? null,
      filename,
      size,
      updatedAt: new Date(),
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
      bitDepth: metadata?.bitDepth ?? 0,
      channels: metadata?.channels ?? null,
      format: metadata?.format ?? null,
    };
  }
}
