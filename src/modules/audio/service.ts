import { status } from "elysia";
import { existsSync, unlinkSync } from "fs";
import { writeFile, mkdir, stat } from "fs/promises";
import { join, extname } from "path";
import * as mm from "music-metadata";
import type { AudioModel } from "./model";
import { AudioRepository } from "../../db/repository";
import {
  generateId,
  UPLOADS_DIR,
  ALLOWED_AUDIO_EXTENSIONS,
  MAX_FILE_SIZE,
  getImageFileName,
} from "../../utils/helpers";

await mkdir(UPLOADS_DIR, { recursive: true });

export abstract class AudioService {
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
      console.error("Metadata extraction failed:", error);
      return null;
    }
  }

  static async extractAlbumArt(
    filePath: string,
    audioId: string
  ): Promise<string | null> {
    try {
      const metadata = await mm.parseFile(filePath);
      const picture = metadata.common.picture?.[0];

      if (!picture) {
        return null;
      }

      const extension =
        picture.format === "image/jpeg"
          ? ".jpg"
          : picture.format === "image/png"
            ? ".png"
            : ".jpg";
      const imageFileName = getImageFileName(audioId, extension);
      const imagePath = join(UPLOADS_DIR, imageFileName);

      await writeFile(imagePath, picture.data);
      return imageFileName;
    } catch (error) {
      console.error("Album art extraction failed:", error);
      return null;
    }
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

    const { files: dbFiles, total } = await AudioRepository.findAll({
      page,
      limit,
      sortBy,
      sortOrder,
    });

    const files = dbFiles.map((dbFile) => AudioRepository.toAudioModel(dbFile));

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

    const extractedImage = await this.extractAlbumArt(filePath, id);

    const extractedMetadata = await this.extractMetadata(filePath);

    await AudioRepository.create(
      AudioRepository.fromMetadata(
        id,
        filename,
        file.size,
        extractedMetadata ?? undefined,
        extractedImage ?? undefined
      )
    );

    return {
      success: true,
      id,
      filename,
      imageFile: extractedImage || undefined,
      message: "File uploaded successfully",
    };
  }

  static async uploadFiles(
    files: File[]
  ): Promise<AudioModel.multiUploadResponse> {
    if (!files || files.length === 0) {
      throw status(400, "No files provided");
    }

    const uploadPromises = files.map(async (file) => {
      try {
        const result = await this.uploadFile(file);
        return result;
      } catch (error: any) {
        const errorMessage = error.message || "Unknown error occurred";
        return {
          success: false as const,
          filename: file.name,
          error: errorMessage,
        };
      }
    });

    const results = await Promise.all(uploadPromises);
    const successfulUploads = results.filter((r) => r.success).length;
    const failedUploads = results.filter((r) => !r.success).length;
    const totalFiles = files.length;
    const allSuccessful = failedUploads === 0;

    return {
      success: allSuccessful,
      results,
      totalFiles,
      successfulUploads,
      failedUploads,
      message: allSuccessful
        ? `Successfully uploaded ${successfulUploads} file${successfulUploads !== 1 ? "s" : ""}`
        : `Uploaded ${successfulUploads} of ${totalFiles} files. ${failedUploads} failed.`,
    };
  }

  static async downloadYoutube(
    url: string
  ): Promise<AudioModel.youtubeResponse> {
    try {
      const id = generateId();
      const filename = `${id}.mp3`;
      const filePath = join(UPLOADS_DIR, filename);
      const cookiesPath = join(process.cwd(), "cookies.txt");

      const hasCookies = existsSync(cookiesPath);

      const ytDlpArgs = [
        ...(hasCookies ? ["--cookies", cookiesPath] : []),
        "--user-agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        "-x",
        "--audio-format",
        "mp3",
        "--embed-metadata",
        "--embed-thumbnail",
        "-o",
        filePath,
        url,
      ];

      const proc = Bun.spawn(["yt-dlp", ...ytDlpArgs], {
        stdout: "pipe",
        stderr: "pipe",
      });

      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`yt-dlp failed: ${stderr}`);
      }

      if (!existsSync(filePath)) {
        throw new Error("Downloaded file not found");
      }

      const stats = await stat(filePath);

      const extractedMetadata = await this.extractMetadata(filePath);
      const extractedImage = await this.extractAlbumArt(filePath, id);

      await AudioRepository.create(
        AudioRepository.fromMetadata(
          id,
          filename,
          stats.size,
          extractedMetadata ?? undefined,
          extractedImage ?? undefined
        )
      );

      return {
        success: true,
        id,
        filename,
        title: extractedMetadata?.title || filename,
        imageFile: extractedImage || undefined,
        message: "YouTube audio downloaded successfully",
      };
    } catch (error) {
      throw status(500, `Failed to download YouTube audio: ${error}`);
    }
  }

  static async getAllAudioFiles(): Promise<AudioModel.audioFile[]> {
    const { files: dbFiles } = await AudioRepository.findAll({ limit: 1000 });
    return dbFiles.map((dbFile) => AudioRepository.toAudioModel(dbFile));
  }

  static async getAudioById(id: string): Promise<AudioModel.audioFile> {
    const dbFile = await AudioRepository.findById(id);

    if (!dbFile) {
      throw status(404, "Audio file not found");
    }

    return AudioRepository.toAudioModel(dbFile);
  }

  static async deleteAudio(id: string): Promise<AudioModel.deleteResponse> {
    const file = await this.getAudioById(id);
    const filePath = join(UPLOADS_DIR, file.filename);

    try {
      unlinkSync(filePath);

      if (file.imageFile) {
        const imagePath = join(UPLOADS_DIR, file.imageFile);
        if (existsSync(imagePath)) {
          unlinkSync(imagePath);
        }
      }

      await AudioRepository.delete(id);

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

  static async getImageStream(
    id: string
  ): Promise<{ file: AudioModel.audioFile; imagePath: string }> {
    const file = await this.getAudioById(id);

    if (!file.imageFile) {
      throw status(404, "No image file found for this audio");
    }

    const imagePath = join(UPLOADS_DIR, file.imageFile);

    if (!existsSync(imagePath)) {
      throw status(404, "Image file not found on disk");
    }

    return { file, imagePath };
  }

  static async search(
    query: string,
    options?: {
      page?: number;
      limit?: number;
    }
  ): Promise<AudioModel.audioListResponse> {
    const { page = 1, limit = 20 } = options || {};

    const { files: dbFiles, total } = await AudioRepository.search(query, {
      page,
      limit,
    });

    const files = dbFiles.map((dbFile) => AudioRepository.toAudioModel(dbFile));

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
    limit: number = 5
  ): Promise<AudioModel.searchSuggestionsResponse> {
    const suggestions = await AudioRepository.searchSuggestions(query, limit);
    return { suggestions };
  }
}
