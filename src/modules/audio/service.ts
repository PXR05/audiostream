import { status } from "elysia";
import { existsSync, unlinkSync } from "fs";
import { join, extname } from "path";
import * as mm from "music-metadata";
import jimp from "jimp";
import type { AudioModel } from "./model";
import {
  AudioRepository,
  AudioFileUserRepository,
} from "../../db/repositories";
import {
  generateId,
  TEMP_DIR,
  ALLOWED_AUDIO_EXTENSIONS,
  MAX_FILE_SIZE,
  getWebPImageFileName,
} from "../../utils/helpers";
import { logger } from "../../utils/logger";
import { Storage } from "../../utils/storage";
import { searchTidalTracks } from "../../utils/tidal";
import { normalizeIsrc } from "../../utils/isrc";

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
  static async extractMetadata(
    filePath: string,
  ): Promise<AudioModel.audioMetadata | null> {
    try {
      let metadata: mm.IAudioMetadata;
      try {
        metadata = await mm.parseFile(filePath, { skipCovers: true });
      } catch {
        metadata = await mm.parseFile(filePath, {
          skipCovers: true,
          skipPostHeaders: true,
        });
      }
      return {
        title: metadata.common.title,
        artist: metadata.common.artist,
        album: metadata.common.album,
        isrc: normalizeIsrc(metadata.common.isrc) ?? undefined,
        year: metadata.common.year,
        genre: metadata.common.genre,
        duration: metadata.format.duration,
        bitrate: metadata.format.bitrate,
        sampleRate: metadata.format.sampleRate,
        channels: metadata.format.numberOfChannels,
        format: metadata.format.container,
      };
    } catch (error) {
      logger.error("Metadata extraction failed", error, { context: "AUDIO" });
      return null;
    }
  }

  static async extractAlbumArt(
    filePath: string,
    audioId: string,
  ): Promise<string | null> {
    const webpImageFileName = getWebPImageFileName(audioId);
    const tempImagePath = join(TEMP_DIR, webpImageFileName);
    try {
      let pictures: mm.IPicture[] = [];
      try {
        const metadata = await mm.parseFile(filePath);
        pictures = metadata.common.picture ?? [];
      } catch {
        logger.warn("Embedded album art parse failed, using ffmpeg fallback", {
          context: "AUDIO",
        });
      }

      for (const picture of pictures) {
        try {
          const image = await jimp.read(Buffer.from(picture.data));
          const w = image.getWidth();
          const h = image.getHeight();
          const s = Math.min(w, h);
          await image
            .crop(Math.floor((w - s) / 2), Math.floor((h - s) / 2), s, s)
            .quality(100)
            .writeAsync(tempImagePath);
          const imageData = await Bun.file(tempImagePath).arrayBuffer();
          await Storage.upload(
            webpImageFileName,
            new Uint8Array(imageData),
            "image/webp",
          );
          return webpImageFileName;
        } catch {
          logger.warn("Skipping invalid embedded album art frame", {
            context: "AUDIO",
          });
        }
      }

      const fallbackCoverPath = join(TEMP_DIR, `cover_${audioId}.jpg`);
      const extractProc = Bun.spawn(
        [
          "ffmpeg",
          "-i",
          filePath,
          "-an",
          "-frames:v",
          "1",
          "-q:v",
          "2",
          "-y",
          fallbackCoverPath,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      await extractProc.exited;

      if (!existsSync(fallbackCoverPath)) return null;

      const fallbackImage = await jimp.read(fallbackCoverPath);
      const fw = fallbackImage.getWidth();
      const fh = fallbackImage.getHeight();
      const fs = Math.min(fw, fh);
      await fallbackImage
        .crop(Math.floor((fw - fs) / 2), Math.floor((fh - fs) / 2), fs, fs)
        .quality(100)
        .writeAsync(tempImagePath);

      const imageData = await Bun.file(tempImagePath).arrayBuffer();
      await Storage.upload(
        webpImageFileName,
        new Uint8Array(imageData),
        "image/webp",
      );
      if (existsSync(fallbackCoverPath)) unlinkSync(fallbackCoverPath);
      return webpImageFileName;
    } catch (error) {
      logger.error("Album art extraction failed", error, { context: "AUDIO" });
      return null;
    } finally {
      if (existsSync(tempImagePath)) unlinkSync(tempImagePath);
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
    sortBy?: "filename" | "size" | "uploadedAt" | "title";
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
      const [extractedImage, extractedMetadata] = await Promise.all([
        this.extractAlbumArt(tempFilePath, id),
        this.extractMetadata(tempFilePath),
      ]);
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
          extractedMetadata ?? undefined,
          extractedImage ?? undefined,
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
    return AudioRepository.toAudioModel(dbFile);
  }

  static async deleteAudio(
    id: string,
    userId: string,
  ): Promise<AudioModel.deleteResponse> {
    const userAudioMap = await AudioFileUserRepository.findByAudioFileId(id);
    if (userAudioMap.length > 1) {
      await AudioFileUserRepository.deleteByAudioAndUser(id, userId);
      return { success: true, message: "File removed from your library" };
    }
    const file = await this.getAudioById(id, userId);
    try {
      await Storage.delete(file.filename);
      if (file.imageFile) {
        if (await Storage.exists(file.imageFile))
          await Storage.delete(file.imageFile);
      }
      await AudioRepository.delete(id);
      return { success: true, message: "File deleted successfully" };
    } catch {
      throw status(500, "Failed to delete file");
    }
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

  static async searchYoutube(
    query: string,
  ): Promise<AudioModel.youtubeSearchResponse> {
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) throw new Error("YOUTUBE_API_KEY is not configured");
    const params = new URLSearchParams({
      part: "snippet",
      q: query,
      type: "video",
      videoCategoryId: "10",
      maxResults: "10",
      key: apiKey,
    });
    const response = await fetch(
      `https://www.googleapis.com/youtube/v3/search?${params}`,
    );
    if (!response.ok)
      throw new Error(`YouTube API error: ${await response.text()}`);
    const data = await response.json();
    return data.items.map(
      (item: {
        id: { videoId: string };
        snippet: {
          title: string;
          channelTitle: string;
          thumbnails: { medium: { url: string } };
        };
      }) => ({
        videoId: item.id.videoId,
        title: item.snippet.title,
        artist: item.snippet.channelTitle,
        thumbnail: item.snippet.thumbnails.medium.url,
      }),
    );
  }

  static async searchTidal(
    query: string,
  ): Promise<AudioModel.tidalSearchResponse> {
    return await searchTidalTracks(query, 10);
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
      count: total,
      page,
      limit,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    };
  }
}
