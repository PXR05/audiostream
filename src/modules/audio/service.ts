import { status } from "elysia";
import { existsSync, unlinkSync, readdirSync, statSync } from "fs";
import { writeFile, mkdir } from "fs/promises";
import { join, extname } from "path";
import { Innertube } from "youtubei.js/web";
import * as mm from "music-metadata";
import type { AudioModel } from "./model";
import { MetadataCache } from "../../utils/metadata";
import {
  generateId,
  getEnvLocale,
  UPLOADS_DIR,
  ALLOWED_AUDIO_EXTENSIONS,
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
      console.error("[META_EXTRACT]:", error);
      return null;
    }
  }

  static async getAudioFiles(): Promise<AudioModel.audioFile[]> {
    await MetadataCache.load();

    try {
      const files = readdirSync(UPLOADS_DIR);
      return files
        .filter((file) =>
          ALLOWED_AUDIO_EXTENSIONS.includes(extname(file).toLowerCase())
        )
        .map((filename) => {
          const filePath = join(UPLOADS_DIR, filename);
          const stats = statSync(filePath);
          const metadata = MetadataCache.get(filename);

          return {
            id: filename.replace(/\.[^/.]+$/, ""),
            filename,
            size: stats.size,
            uploadedAt: stats.mtime,
            metadata,
          };
        });
    } catch {
      return [];
    }
  }

  static async uploadFile(file: File): Promise<AudioModel.uploadResponse> {
    if (!file) {
      throw status(400, "No file provided");
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

    const arrayBuffer = await file.arrayBuffer();
    await writeFile(filePath, new Uint8Array(arrayBuffer));

    this.extractMetadata(filePath)
      .then((metadata) => {
        if (metadata) {
          MetadataCache.set(filename, metadata);
        }
      })
      .catch((err) => console.error("[UPLOAD]:", err));

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
        lang: getEnvLocale().lang,
        location: getEnvLocale().country,
        user_agent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
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

      const chunks: Uint8Array[] = [];
      const reader = stream.getReader();

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
      const audioBuffer = new Uint8Array(totalLength);
      let offset = 0;

      for (const chunk of chunks) {
        audioBuffer.set(chunk, offset);
        offset += chunk.length;
      }

      await writeFile(filePath, audioBuffer);

      const youtubeMetadata: AudioModel.audioMetadata = {
        title: info.basic_info.title,
        artist: info.basic_info.author,
        duration: info.basic_info.duration,
      };

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

  static async getAudioById(id: string): Promise<AudioModel.audioFile> {
    const files = await this.getAudioFiles();
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
