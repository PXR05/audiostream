import { db } from "./index";
import { audioFiles, type NewAudioFile, type AudioFile } from "./schema";
import { eq, asc, desc, sql } from "drizzle-orm";
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
