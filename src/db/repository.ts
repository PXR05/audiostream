import { db } from "./index";
import { audioFiles, type NewAudioFile, type AudioFile } from "./schema";
import { eq, asc, desc, sql, or, like } from "drizzle-orm";
import type { AudioModel } from "../modules/audio/model";

export abstract class AudioRepository {
  static async create(data: NewAudioFile): Promise<AudioFile> {
    const result = await db.insert(audioFiles).values(data).returning();
    return result[0];
  }

  static async findAll(options?: {
    page?: number;
    limit?: number;
    sortBy?: "filename" | "size" | "uploadedAt" | "title";
    sortOrder?: "asc" | "desc";
  }): Promise<{ files: AudioFile[]; total: number }> {
    const page = options?.page ?? 1;
    const limit = options?.limit ?? 20;
    const offset = (page - 1) * limit;
    const sortBy = options?.sortBy ?? "uploadedAt";
    const sortOrder = options?.sortOrder ?? "desc";

    let orderByColumn;
    switch (sortBy) {
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

    const files = await db
      .select()
      .from(audioFiles)
      .orderBy(orderBy)
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(audioFiles);
    const total = countResult[0]?.count ?? 0;

    return { files, total };
  }

  static async findById(id: string): Promise<AudioFile | null> {
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
    }
  ): Promise<{ files: AudioFile[]; total: number }> {
    const page = options?.page ?? 1;
    const limit = options?.limit ?? 20;
    const offset = (page - 1) * limit;
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

    const files = await db
      .select()
      .from(audioFiles)
      .where(
        or(
          like(audioFiles.title, searchPattern),
          like(audioFiles.artist, searchPattern),
          like(audioFiles.album, searchPattern),
          like(audioFiles.filename, searchPattern)
        )
      )
      .orderBy(desc(relevanceScore))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(audioFiles)
      .where(
        or(
          like(audioFiles.title, searchPattern),
          like(audioFiles.artist, searchPattern),
          like(audioFiles.album, searchPattern),
          like(audioFiles.filename, searchPattern)
        )
      );
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
        type: sql<string>`'title'`,
        value: audioFiles.title,
        score: sql<number>`
          CASE
            WHEN LOWER(${audioFiles.title}) = ${lowerQuery} THEN 4000
            WHEN LOWER(${audioFiles.title}) LIKE ${startsWithPattern} THEN 400
            ELSE 40
          END
        `,
      })
      .from(audioFiles)
      .where(like(audioFiles.title, searchPattern));

    const artistQuery = db
      .selectDistinct({
        type: sql<string>`'artist'`,
        value: audioFiles.artist,
        score: sql<number>`
          CASE
            WHEN LOWER(${audioFiles.artist}) = ${lowerQuery} THEN 3000
            WHEN LOWER(${audioFiles.artist}) LIKE ${startsWithPattern} THEN 300
            ELSE 30
          END
        `,
      })
      .from(audioFiles)
      .where(like(audioFiles.artist, searchPattern));

    const albumQuery = db
      .selectDistinct({
        type: sql<string>`'album'`,
        value: audioFiles.album,
        score: sql<number>`
          CASE
            WHEN LOWER(${audioFiles.album}) = ${lowerQuery} THEN 2000
            WHEN LOWER(${audioFiles.album}) LIKE ${startsWithPattern} THEN 200
            ELSE 20
          END
        `,
      })
      .from(audioFiles)
      .where(like(audioFiles.album, searchPattern));

    const results = await titleQuery
      .unionAll(artistQuery)
      .unionAll(albumQuery)
      .orderBy(desc(sql`score`));

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
    imageFile?: string
  ): NewAudioFile {
    return {
      id,
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
