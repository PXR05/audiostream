import { status } from "elysia";
import { existsSync, unlinkSync } from "fs";
import { writeFile, mkdir, readdir, stat } from "fs/promises";
import { join, extname } from "path";
import { Innertube, Log } from "youtubei.js/web";
import * as mm from "music-metadata";
import type { AudioModel } from "./model";
import { MetadataCache } from "../../utils/metadata";
import {
  generateId,
  UPLOADS_DIR,
  ALLOWED_AUDIO_EXTENSIONS,
  MAX_FILE_SIZE,
} from "../../utils/helpers";

await mkdir(UPLOADS_DIR, { recursive: true });

export abstract class AudioService {
  private static fileListCache: {
    files: AudioModel.audioFile[];
    timestamp: number;
  } | null = null;
  private static readonly CACHE_TTL = 30000;

  static async extractMetadata(
    filePath: string
  ): Promise<AudioModel.audioMetadata | null> {
    try {
      const metadata = await mm.parseFile(filePath);
      return {
        title: metadata.common.title,
        artist: metadata.common.artist,
        album: metadata.common.album,
        year: metadata.common.year,
        genre: metadata.common.genre,
        duration: metadata.format.duration,
        bitrate: metadata.format.bitrate,
        sampleRate: metadata.format.sampleRate,
        channels: metadata.format.numberOfChannels,
        format: metadata.format.container,
      };
    } catch (error) {
      console.error("[META_EXTRACT]:", error);
      return null;
    }
  }

  private static async loadAllFiles(): Promise<AudioModel.audioFile[]> {
    const now = Date.now();

    if (
      this.fileListCache &&
      now - this.fileListCache.timestamp < this.CACHE_TTL
    ) {
      return this.fileListCache.files;
    }

    await MetadataCache.load();

    try {
      const files = await readdir(UPLOADS_DIR);
      const audioFiles = files.filter((file) =>
        ALLOWED_AUDIO_EXTENSIONS.includes(extname(file).toLowerCase())
      );

      const filePromises = audioFiles.map(async (filename) => {
        const filePath = join(UPLOADS_DIR, filename);
        const stats = await stat(filePath);
        const metadata = MetadataCache.get(filename);

        return {
          id: filename.replace(/\.[^/.]+$/, ""),
          filename,
          size: stats.size,
          uploadedAt: stats.mtime,
          metadata,
        };
      });

      const allFiles = await Promise.all(filePromises);

      this.fileListCache = {
        files: allFiles,
        timestamp: now,
      };

      return allFiles;
    } catch {
      return [];
    }
  }

  static invalidateCache(): void {
    this.fileListCache = null;
  }

  static async getAudioFiles(options?: {
    page?: number;
    limit?: number;
    sortBy?: "filename" | "size" | "uploadedAt" | "title";
    sortOrder?: "asc" | "desc";
  }): Promise<AudioModel.audioListResponse> {
    const {
      page = 1,
      limit = 20,
      sortBy = "uploadedAt",
      sortOrder = "desc",
    } = options || {};

    const allFiles = await this.loadAllFiles();

    const sortedFiles = allFiles.sort((a, b) => {
      let aValue: any, bValue: any;

      switch (sortBy) {
        case "filename":
          aValue = a.filename.toLowerCase();
          bValue = b.filename.toLowerCase();
          break;
        case "size":
          aValue = a.size;
          bValue = b.size;
          break;
        case "uploadedAt":
          aValue = a.uploadedAt.getTime();
          bValue = b.uploadedAt.getTime();
          break;
        case "title":
          aValue = (a.metadata?.title || a.filename).toLowerCase();
          bValue = (b.metadata?.title || b.filename).toLowerCase();
          break;
        default:
          aValue = a.uploadedAt.getTime();
          bValue = b.uploadedAt.getTime();
      }

      if (sortOrder === "asc") {
        return aValue < bValue ? -1 : aValue > bValue ? 1 : 0;
      } else {
        return aValue > bValue ? -1 : aValue < bValue ? 1 : 0;
      }
    });

    const totalCount = sortedFiles.length;
    const totalPages = Math.ceil(totalCount / limit);
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    const paginatedFiles = sortedFiles.slice(startIndex, endIndex);

    return {
      files: paginatedFiles,
      count: totalCount,
      page,
      limit,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    };
  }

  static async uploadFile(file: File): Promise<AudioModel.uploadResponse> {
    if (!file) {
      throw status(400, "No file provided");
    }

    if (file.size > MAX_FILE_SIZE) {
      throw status(
        413,
        `File too large. Maximum size: ${MAX_FILE_SIZE / (1024 * 1024)}MB`
      );
    }

    const ext = extname(file.name).toLowerCase();
    if (!ALLOWED_AUDIO_EXTENSIONS.includes(ext)) {
      throw status(
        400,
        `Invalid audio format. Allowed: ${ALLOWED_AUDIO_EXTENSIONS.join(", ")}`
      );
    }

    const id = generateId();
    const filename = `${id}${ext}`;
    const filePath = join(UPLOADS_DIR, filename);

    const stream = file.stream();
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
    const fileBuffer = new Uint8Array(totalLength);
    let offset = 0;

    for (const chunk of chunks) {
      fileBuffer.set(chunk, offset);
      offset += chunk.length;
    }

    await writeFile(filePath, fileBuffer);

    this.invalidateCache();

    setImmediate(async () => {
      try {
        const metadata = await this.extractMetadata(filePath);
        if (metadata) {
          MetadataCache.set(filename, metadata);
        }
      } catch (err) {
        console.error("[UPLOAD_META]:", err);
      }
    });

    return {
      success: true,
      id,
      filename,
      message: "File uploaded successfully",
    };
  }

  static async downloadYoutube(
    url: string
  ): Promise<AudioModel.youtubeResponse> {
    try {
      const youtube = await Innertube.create({
        user_agent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      });

      const info = await youtube.getBasicInfo(url);

      if (!info.basic_info?.title) {
        throw status(400, "Could not get video information");
      }

      const stream = await youtube.download(url, {
        type: "audio",
        quality: "best",
      });
      const id = generateId();
      const filename = `${id}.mp3`;
      const filePath = join(UPLOADS_DIR, filename);

      const file = Bun.file(filePath);
      const writer = file.writer();
      const reader = stream.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          writer.write(value);
        }
      } finally {
        reader.releaseLock();
        writer.end();
      }

      const youtubeMetadata: AudioModel.audioMetadata = {
        title: info.basic_info.title,
        artist: info.basic_info.author,
        duration: info.basic_info.duration,
      };

      this.invalidateCache();

      this.extractMetadata(filePath)
        .then((audioMetadata) => {
          const mergedMetadata = { ...youtubeMetadata, ...audioMetadata };
          MetadataCache.set(filename, mergedMetadata);
        })
        .catch((err) => console.error("[YOUTUBE]:", err));

      return {
        success: true,
        id,
        filename,
        title: info.basic_info.title,
        message: "YouTube audio downloaded successfully",
      };
    } catch (error) {
      throw status(500, `Failed to download YouTube audio: ${error}`);
    }
  }

  static async getAllAudioFiles(): Promise<AudioModel.audioFile[]> {
    const response = await this.getAudioFiles({ limit: 1000 });
    return response.files;
  }

  static async getAudioById(id: string): Promise<AudioModel.audioFile> {
    const files = await this.getAllAudioFiles();
    const file = files.find((f) => f.id === id || f.filename === id);

    if (!file) {
      throw status(404, "Audio file not found");
    }

    return file;
  }

  static async deleteAudio(id: string): Promise<AudioModel.deleteResponse> {
    const file = await this.getAudioById(id);
    const filePath = join(UPLOADS_DIR, file.filename);

    try {
      unlinkSync(filePath);
      MetadataCache.delete(file.filename);
      this.invalidateCache();
      return { success: true, message: "File deleted successfully" };
    } catch {
      throw status(500, "Failed to delete file");
    }
  }

  static async getAudioStream(
    id: string
  ): Promise<{ file: AudioModel.audioFile; filePath: string }> {
    const file = await this.getAudioById(id);
    const filePath = join(UPLOADS_DIR, file.filename);

    if (!existsSync(filePath)) {
      throw status(404, "File not found on disk");
    }

    return { file, filePath };
  }
}
