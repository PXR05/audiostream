import { existsSync, unlinkSync, renameSync } from "fs";
import { join, extname } from "path";
import jimp from "jimp";
import { TEMP_DIR, getWebPImageFileName} from "../../../utils/helpers";
import { logger } from "../../../utils/logger";
import { Storage } from "../../../utils/storage";
import {
  PlaylistRepository,
  AudioFileUserRepository,
} from "../../../db/repositories";
import { AudioModel } from "../model";

export type EmitProgress = (event: AudioModel.youtubeProgressEvent) => void;

export interface DownloadOptions {
  url: string;
  userId: string;
  sendEvent: EmitProgress;
  signal?: AbortSignal;
  quality?: string;
}

export interface InFlightEntry {
  subscribers: Set<EmitProgress>;
  promise: Promise<AudioModel.youtubeResponse>;
}

export abstract class BaseAudioProvider {
  abstract readonly name: string;

  protected static inFlightDownloads = new Map<string, InFlightEntry>();

  abstract search(query: string): Promise<any[]>;
  abstract download(options: DownloadOptions): Promise<void>;

  protected hasCookies(): boolean {
    try {
      return existsSync("cookies.txt");
    } catch {
      return false;
    }
  }

  protected registerInFlight(
    key: string,
    sendEvent: EmitProgress,
  ): {
    broadcast: EmitProgress;
    resolve: (r: AudioModel.youtubeResponse) => void;
    reject: (e: Error) => void;
  } {
    const subscribers = new Set<EmitProgress>();
    let resolve!: (r: AudioModel.youtubeResponse) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<AudioModel.youtubeResponse>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    BaseAudioProvider.inFlightDownloads.set(key, { subscribers, promise });
    const broadcast: EmitProgress = (event) => {
      sendEvent(event);
      for (const sub of subscribers) sub(event);
    };
    return { broadcast, resolve, reject };
  }

  protected async ensureUserLibraryEntry(options: {
    audioFileId: string;
    userId: string;
    playlistId?: string;
    playlistIndex?: number;
  }): Promise<{ alreadyMapped: boolean }> {
    const { audioFileId, userId, playlistId, playlistIndex } = options;
    const existing = await AudioFileUserRepository.findByAudioAndUser(
      audioFileId,
      userId,
      { includeDeleted: true },
    );
    if (!existing) {
      await AudioFileUserRepository.create({
        id: crypto.randomUUID(),
        audioFileId,
        userId,
      });
    } else if (existing.deletedAt) {
      await AudioFileUserRepository.restoreByAudioAndUser(audioFileId, userId);
    }
    if (playlistId) {
      const existingItem = await PlaylistRepository.findItemByAudioAndPlaylist(
        playlistId,
        audioFileId,
      );
      const position =
        playlistIndex !== undefined
          ? playlistIndex - 1
          : (await PlaylistRepository.getMaxPosition(playlistId)) + 1;
      if (!existingItem) {
        await PlaylistRepository.addItem({
          id: crypto.randomUUID(),
          playlistId,
          audioId: audioFileId,
          position,
          addedAt: new Date(),
        });
      } else if (playlistIndex !== undefined) {
        await PlaylistRepository.updateItemPosition(
          playlistId,
          audioFileId,
          position,
        );
      }
    }
    return { alreadyMapped: !!existing && !existing.deletedAt };
  }

  protected async embedMetadataWithFfmpeg(
    filePath: string,
    metadata: {
      title?: string;
      artist?: string;
      album?: string;
      albumArtist?: string;
      trackNumber?: number;
      discNumber?: number;
      releaseDate?: string;
      year?: number;
      genre?: string;
      composer?: string;
      copyright?: string;
      label?: string;
      upc?: string;
      explicit?: boolean;
      comment?: string;
      isrc?: string;
      coverImagePath?: string;
    },
  ): Promise<void> {
    const ext = extname(filePath);
    const outputPath = ext ? `${filePath}.tagged${ext}` : `${filePath}.tagged`;

    const metadataPairs: Array<[string, string]> = [];
    const addPair = (key: string, value: unknown) => {
      if (value === undefined || value === null) return;
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.length === 0) return;
        metadataPairs.push([key, trimmed]);
        return;
      }
      if (typeof value === "number" && Number.isFinite(value)) {
        metadataPairs.push([key, String(value)]);
        return;
      }
      if (typeof value === "boolean") {
        metadataPairs.push([key, value ? "1" : "0"]);
      }
    };

    addPair("title", metadata.title);
    addPair("artist", metadata.artist);
    addPair("album", metadata.album);
    addPair("album_artist", metadata.albumArtist);
    addPair("track", metadata.trackNumber);
    addPair("disc", metadata.discNumber);
    addPair("date", metadata.releaseDate);
    addPair("year", metadata.year);
    addPair("genre", metadata.genre);
    addPair("composer", metadata.composer);
    addPair("copyright", metadata.copyright);
    addPair("publisher", metadata.label);
    addPair("upc", metadata.upc);
    addPair("isrc", metadata.isrc);
    addPair(
      "comment",
      metadata.comment ?? (metadata.explicit ? "Explicit" : undefined),
    );

    const runTagging = async (
      coverPath: string | undefined,
    ): Promise<{ ok: boolean; stderr: string }> => {
      const args = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        filePath,
      ];

      if (coverPath && existsSync(coverPath)) {
        args.push("-i", coverPath, "-map", "0:a", "-map", "1:v");
      }

      args.push("-map_metadata", "0", "-c:a", "copy");

      if (coverPath && existsSync(coverPath)) {
        args.push(
          "-c:v",
          "mjpeg",
          "-disposition:v",
          "attached_pic",
          "-metadata:s:v",
          "title=Cover",
          "-metadata:s:v",
          "comment=Cover (front)",
        );
      }

      for (const [key, value] of metadataPairs) {
        args.push("-metadata", `${key}=${value}`);
      }

      args.push("-y", outputPath);

      const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
      const [exitCode, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stderr).text(),
      ]);
      return {
        ok: exitCode === 0 && existsSync(outputPath),
        stderr,
      };
    };

    try {
      const coverPath = metadata.coverImagePath;
      let tagged = await runTagging(coverPath);

      if (!tagged.ok && coverPath) {
        if (existsSync(outputPath)) unlinkSync(outputPath);
        logger.warn(
          `Cover-art embedding failed, retrying without cover: ${tagged.stderr.substring(0, 300)}`,
          { context: "AUDIO_PROVIDER" },
        );
        tagged = await runTagging(undefined);
      }

      if (tagged.ok) {
        if (existsSync(filePath)) unlinkSync(filePath);
        renameSync(outputPath, filePath);
      } else {
        logger.warn(
          `Failed to embed metadata with ffmpeg: ${tagged.stderr.substring(0, 300)}`,
          {
            context: "AUDIO_PROVIDER",
          },
        );
      }
    } catch {
      logger.warn("Failed to embed metadata with ffmpeg", { context: "AUDIO_PROVIDER" });
    } finally {
      if (existsSync(outputPath)) unlinkSync(outputPath);
    }
  }

  protected async downloadCoverForEmbedding(
    coverUrl: string,
    audioId: string,
  ): Promise<string | null> {
    const tempCoverPath = join(TEMP_DIR, `${audioId}.cover.jpg`);
    try {
      const resp = await fetch(coverUrl, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) return null;

      const image = await jimp.read(Buffer.from(await resp.arrayBuffer()));
      const w = image.getWidth();
      const h = image.getHeight();
      const s = Math.min(w, h);

      await image
        .crop(Math.floor((w - s) / 2), Math.floor((h - s) / 2), s, s)
        .quality(100)
        .writeAsync(tempCoverPath);

      return tempCoverPath;
    } catch (error) {
      logger.error("Cover art download for embedding failed", error, {
        context: "AUDIO_PROVIDER",
      });
      if (existsSync(tempCoverPath)) {
        try {
          unlinkSync(tempCoverPath);
        } catch {}
      }
      return null;
    }
  }

  protected async downloadCoverFromUrl(
    coverUrl: string,
    audioId: string,
  ): Promise<string | null> {
    const webpImageFileName = getWebPImageFileName(audioId);
    const tempImagePath = join(TEMP_DIR, webpImageFileName);
    try {
      const resp = await fetch(coverUrl, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) return null;
      const image = await jimp.read(Buffer.from(await resp.arrayBuffer()));
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
    } catch (error) {
      logger.error("Cover art download from URL failed", error, {
        context: "AUDIO_PROVIDER",
      });
      return null;
    } finally {
      if (existsSync(tempImagePath)) unlinkSync(tempImagePath);
    }
  }
}
