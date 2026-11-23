import { status } from "elysia";
import { existsSync, unlinkSync } from "fs";
import { extname, join } from "path";
import {
  AudioFileUserRepository,
  AudioRepository,
  PlaylistRepository,
} from "../../db/repositories";
import {
  ALLOWED_AUDIO_EXTENSIONS,
  generateId,
  MAX_FILE_SIZE,
  TEMP_DIR,
} from "../../utils/helpers";
import { logger } from "../../utils/logger";
import {
  extractAndStoreCoverArt,
  extractAudioMetadata,
  serializeExtraMetadata,
} from "../../utils/metadata";
import { Storage } from "../../utils/storage";
import type { AudioModel } from "./model";

function createSeededRandom(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    const char = seed.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return function () {
    hash = (hash + 0x6d2b79f5) | 0;
    let t = Math.imul(hash ^ (hash >>> 15), 1 | hash);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleWithSeed<T>(array: T[], seed: string): T[] {
  const shuffled = [...array];
  const random = createSeededRandom(seed);
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export abstract class AudioService {
  private static streamTickets = new Map<
    string,
    {
      userId: string;
      username: string;
      role: "admin" | "user";
      sessionId: string;
      trackId: string;
      expiresAt: number;
    }
  >();

  static async createStreamTicket(
    trackId: string,
    authData: {
      userId: string;
      username: string;
      role: "admin" | "user";
      sessionId: string;
    },
    ttlSeconds: number = 300,
  ): Promise<{ ticket: string; expiresAt: number }> {
    await this.getAudioById(trackId, authData.userId);

    const ticket = `st_${crypto.randomUUID()}`;
    const expiresAt = Date.now() + ttlSeconds * 1000;

    this.streamTickets.set(ticket, {
      userId: authData.userId,
      username: authData.username,
      role: authData.role,
      sessionId: authData.sessionId,
      trackId,
      expiresAt,
    });

    this.cleanExpiredTickets();

    return { ticket, expiresAt };
  }

  static validateStreamTicket(ticketId: string, trackId?: string) {
    const data = this.streamTickets.get(ticketId);
    if (!data) return null;

    if (Date.now() > data.expiresAt) {
      this.streamTickets.delete(ticketId);
      return null;
    }

    if (trackId && data.trackId !== trackId) {
      return null;
    }

    return {
      userId: data.userId,
      username: data.username,
      role: data.role,
      isAdmin: data.role === "admin",
      sessionId: data.sessionId,
    };
  }

  private static cleanExpiredTickets() {
    const now = Date.now();
    for (const [ticketId, data] of this.streamTickets.entries()) {
      if (now > data.expiresAt) {
        this.streamTickets.delete(ticketId);
      }
    }
  }

  static async extractMetadata(
    filePath: string,
    originalFilename?: string,
  ): Promise<AudioModel.audioMetadata | null> {
    const extracted = await extractAudioMetadata(filePath, {
      includeCover: false,
      originalFilename,
    });
    return extracted?.metadata ?? null;
  }

  static async extractAlbumArt(
    filePath: string,
    _audioId?: string,
  ): Promise<string | null> {
    return await extractAndStoreCoverArt(filePath);
  }

  static async reextractMetadata(
    audioId: string,
    options?: { updateCover?: boolean },
  ): Promise<AudioModel.audioFile | null> {
    const existing = await AudioRepository.findById(audioId);
    if (!existing) throw status(404, "Audio file not found");

    const tempPath = join(TEMP_DIR, `reextract_${audioId}_${existing.filename}`);
    try {
      const data = await Storage.download(existing.filename);
      await Bun.write(tempPath, data);

      const updateCover = options?.updateCover ?? false;
      const extracted = await extractAudioMetadata(tempPath, {
        includeCover: updateCover,
      });
      if (!extracted) return null;

      const patch = AudioRepository.toMetadataPatch(
        extracted.metadata,
        serializeExtraMetadata(extracted.extra),
      );
      patch.title = patch.title ?? existing.title;
      patch.artist = patch.artist ?? existing.artist;
      patch.album = patch.album ?? existing.album;
      patch.year = patch.year ?? existing.year;
      patch.genre = patch.genre ?? existing.genre;
      patch.duration = patch.duration ?? existing.duration;
      patch.bitrate = patch.bitrate ?? existing.bitrate;
      patch.sampleRate = patch.sampleRate ?? existing.sampleRate;
      patch.channels = patch.channels ?? existing.channels;
      patch.format = patch.format ?? existing.format;
      if ((!patch.bitDepth || patch.bitDepth === 0) && existing.bitDepth > 0) {
        patch.bitDepth = existing.bitDepth;
      }
      if (extracted.metadata.isrc && !existing.isrc) {
        patch.isrc = extracted.metadata.isrc;
      }

      if (updateCover) {
        const newCover = await extractAndStoreCoverArt(
          tempPath,
          extracted.pictures,
        );
        if (newCover) {
          patch.imageFile = newCover;
        }
      }

      const updated = await AudioRepository.update(audioId, patch);
      return updated
        ? AudioRepository.toAudioModel(updated, { includeLyrics: true })
        : null;
    } finally {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    }
  }

  static getAudioContentType(ext: string): string {
    const types: Record<string, string> = {
      ".mp3": "audio/mpeg",
      ".opus": "audio/opus",
      ".wav": "audio/wav",
      ".flac": "audio/flac",
      ".m4a": "audio/mp4",
      ".aac": "audio/aac",
      ".ogg": "audio/ogg",
    };
    return types[ext] ?? "application/octet-stream";
  }

  static async getAudioFiles(options: {
    userId: string;
    page?: number;
    limit?: number;
    sortBy?: "filename" | "size" | "uploadedAt" | "title" | "album";
    sortOrder?: "asc" | "desc";
    lastFetchedAt?: number;
    artist?: string;
    album?: string;
    genre?: string;
  }): Promise<AudioModel.audioListResponse> {
    const {
      page = 1,
      limit = 20,
      sortBy = "uploadedAt",
      sortOrder = "desc",
      userId,
      lastFetchedAt,
      artist,
      album,
      genre,
    } = options;
    const deletedIds =
      lastFetchedAt !== undefined
        ? await AudioRepository.findDeletedIdsSince(
            userId,
            new Date(lastFetchedAt),
          )
        : [];
    const { files: dbFiles, total } = await AudioRepository.findAll({
      page,
      limit,
      sortBy,
      sortOrder,
      userId,
      lastFetchedAt,
      artist,
      album,
      genre,
    });
    const files = dbFiles.map((f) => AudioRepository.toAudioModel(f));
    const totalPages = Math.ceil(total / limit);
    return {
      files,
      deletedIds,
      count: total,
      page,
      limit,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    };
  }

  static async uploadFile(
    file: File,
    userId: string,
  ): Promise<AudioModel.uploadResponse> {
    if (!file) throw status(400, "No file provided");
    if (file.size > MAX_FILE_SIZE) {
      throw status(
        413,
        `File too large. Maximum size: ${MAX_FILE_SIZE / (1024 * 1024)}MB`,
      );
    }
    const ext = extname(file.name).toLowerCase();
    if (!ALLOWED_AUDIO_EXTENSIONS.includes(ext)) {
      throw status(
        400,
        `Invalid audio format. Allowed: ${ALLOWED_AUDIO_EXTENSIONS.join(", ")}`,
      );
    }

    const id = generateId();
    const filename = `${id}${ext}`;
    const tempFilePath = join(TEMP_DIR, filename);

    try {
      await Bun.write(tempFilePath, file);
    } catch (error) {
      logger.error("Failed to write temp file", error, { context: "AUDIO" });
      throw status(500, "Failed to save file");
    }

    try {
      const extracted = await extractAudioMetadata(tempFilePath, {
        includeCover: true,
        originalFilename: file.name,
      });
      const extractedImage = await extractAndStoreCoverArt(
        tempFilePath,
        extracted?.pictures,
      );
      await Storage.uploadFromFile(
        filename,
        tempFilePath,
        this.getAudioContentType(ext),
      );
      await AudioRepository.create(
        AudioRepository.fromMetadata(
          id,
          filename,
          file.size,
          extracted?.metadata,
          extractedImage ?? undefined,
          undefined,
          undefined,
          undefined,
          serializeExtraMetadata(extracted?.extra),
        ),
      );
      if (userId) {
        await AudioFileUserRepository.create({
          id: crypto.randomUUID(),
          audioFileId: id,
          userId,
        });
      }
      return {
        success: true,
        id,
        filename,
        imageFile: extractedImage || undefined,
        message: "File uploaded successfully",
      };
    } finally {
      if (existsSync(tempFilePath)) unlinkSync(tempFilePath);
    }
  }

  static async uploadFiles(
    files: File[],
    userId: string,
  ): Promise<AudioModel.multiUploadResponse> {
    if (!files || files.length === 0) throw status(400, "No files provided");
    const results = await Promise.all(
      files.map(async (file) => {
        try {
          return await this.uploadFile(file, userId);
        } catch (error: any) {
          return {
            success: false as const,
            filename: file.name,
            error: error.message || "Unknown error occurred",
          };
        }
      }),
    );
    const successfulUploads = results.filter((r) => r.success).length;
    const failedUploads = results.filter((r) => !r.success).length;
    const allSuccessful = failedUploads === 0;
    return {
      success: allSuccessful,
      results,
      totalFiles: files.length,
      successfulUploads,
      failedUploads,
      message: allSuccessful
        ? `Successfully uploaded ${successfulUploads} file${successfulUploads !== 1 ? "s" : ""}`
        : `Uploaded ${successfulUploads} of ${files.length} files. ${failedUploads} failed.`,
    };
  }

  static async getAudioById(
    id: string,
    userId: string,
  ): Promise<AudioModel.audioFile> {
    const dbFile = await AudioRepository.findById(id, userId);
    if (!dbFile) throw status(404, "Audio file not found");
    return AudioRepository.toAudioModel(dbFile, { includeLyrics: true });
  }

  static async deleteAudio(
    id: string,
    userId: string,
  ): Promise<AudioModel.deleteResponse> {
    const userLink = await AudioFileUserRepository.findByAudioAndUser(
      id,
      userId,
    );
    if (!userLink) {
      throw status(403, "You don't have access to delete this file");
    }

    const userAudioMap = await AudioFileUserRepository.findByAudioFileId(id);
    const deletedAt = new Date();

    if (userAudioMap.length > 1) {
      await AudioFileUserRepository.softDeleteByAudioAndUser(
        id,
        userId,
        deletedAt,
      );
      await PlaylistRepository.softDeleteItemsByAudioForUser(
        id,
        userId,
        deletedAt,
      );
      return { success: true, message: "File removed from your library" };
    }

    await this.getAudioById(id, userId);
    await AudioRepository.softDelete(id, deletedAt);
    await AudioFileUserRepository.softDeleteByAudioFileId(id, deletedAt);
    await PlaylistRepository.softDeleteItemsByAudio(id, deletedAt);

    return { success: true, message: "File deleted successfully" };
  }

  static async getAudioStreamInfo(
    id: string,
    userId: string,
  ): Promise<{
    file: AudioModel.audioFile;
    size: number;
    contentType: string;
  }> {
    const file = await this.getAudioById(id, userId);
    const metadata = await Storage.getMetadata(file.filename);
    if (!metadata) throw status(404, "File not found in storage");
    return { file, size: metadata.size, contentType: metadata.contentType };
  }

  static async getImageData(
    id: string,
    userId: string,
  ): Promise<{
    file: AudioModel.audioFile;
    data: Buffer;
    contentType: string;
  }> {
    const file = await this.getAudioById(id, userId);
    if (!file.imageFile)
      throw status(404, "No image file found for this audio");
    if (!(await Storage.exists(file.imageFile)))
      throw status(404, "Image not found in storage");
    const data = await Storage.download(file.imageFile);
    const ext = file.imageFile.split(".").pop()?.toLowerCase();
    const contentType =
      ext === "png"
        ? "image/png"
        : ext === "gif"
          ? "image/gif"
          : ext === "webp"
            ? "image/webp"
            : "image/jpeg";
    return { file, data, contentType };
  }

  static async search(
    query: string,
    options: { page?: number; limit?: number; userId: string },
  ): Promise<AudioModel.audioListResponse> {
    const { page = 1, limit = 20, userId } = options;
    const { files: dbFiles, total } = await AudioRepository.search(query, {
      page,
      limit,
      userId,
    });
    const files = dbFiles.map((f) => AudioRepository.toAudioModel(f));
    const totalPages = Math.ceil(total / limit);
    return {
      files,
      deletedIds: [],
      count: total,
      page,
      limit,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    };
  }

  static async searchSuggestions(
    query: string,
    limit: number = 5,
  ): Promise<AudioModel.searchSuggestionsResponse> {
    return {
      suggestions: await AudioRepository.searchSuggestions(query, limit),
    };
  }

  static async getRandomAudioFiles(options: {
    page?: number;
    limit?: number;
    seed?: string;
    firstTrackId?: string;
    userId: string;
  }): Promise<AudioModel.audioListResponse> {
    const {
      page = 1,
      limit = 20,
      seed = "default-seed",
      firstTrackId,
      userId,
    } = options;
    const { files: allDbFiles } = await AudioRepository.findAll({
      page: 1,
      limit: 999999,
      sortBy: "id",
      sortOrder: "asc",
      userId,
    });
    let shuffledFiles = shuffleWithSeed(allDbFiles, seed);
    if (firstTrackId) {
      const idx = shuffledFiles.findIndex((f) => f.id === firstTrackId);
      if (idx !== -1) {
        const [first] = shuffledFiles.splice(idx, 1);
        shuffledFiles.unshift(first);
      }
    }
    const total = shuffledFiles.length;
    const offset = (page - 1) * limit;
    const files = shuffledFiles
      .slice(offset, offset + limit)
      .map((f) => AudioRepository.toAudioModel(f));
    const totalPages = Math.ceil(total / limit);
    return {
      files,
      deletedIds: [],
      count: total,
      page,
      limit,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    };
  }
}
