import { existsSync, unlinkSync, renameSync } from "fs";
import { stat } from "fs/promises";
import { join } from "path";
import jimp from "jimp";
import type { AudioModel } from "./model";
import {
  AudioRepository,
  PlaylistRepository,
  AudioFileUserRepository,
} from "../../db/repositories";
import {
  generateId,
  TEMP_DIR,
  getWebPImageFileName,
} from "../../utils/helpers";
import { logger } from "../../utils/logger";
import { PlaylistService } from "../playlist/service";
import { Storage } from "../../utils/storage";
import {
  parseTidalResourceUrl,
  getDownloadUrl,
  parseManifest,
  downloadDirectToFile,
  downloadDashToFile,
  getTidalTrackInfo,
  getTidalCollectionInfo,
} from "../../utils/tidal";
import { AudioService } from "./service";

type Emit = (event: AudioModel.youtubeProgressEvent) => void;

type InFlightEntry = {
  subscribers: Set<Emit>;
  promise: Promise<AudioModel.youtubeResponse>;
};

export abstract class DownloadService {
  private static inFlightDownloads = new Map<string, InFlightEntry>();

  private static hasCookies(): boolean {
    try {
      return existsSync("cookies.txt");
    } catch {
      return false;
    }
  }

  private static ytDlpBaseArgs(cookies: boolean): string[] {
    return [
      ...(cookies ? ["--cookies", "cookies.txt"] : []),
      "--extractor-args",
      "youtube:player_client=default,mweb",
      "-f",
      "bestaudio",
      "-x",
      "--audio-format",
      "opus",
      "--embed-metadata",
      "--embed-thumbnail",
      "--parse-metadata",
      "%(artist,uploader,channel,creator)s:%(meta_artist)s",
      "--parse-metadata",
      "%(meta_artist)s:%(album_artist)s",
      "--parse-metadata",
      "%(meta_artist)s:%(artist)s",
      "--replace-in-metadata",
      "artist",
      "^([^,&]+).*",
      "\\1",
    ];
  }

  private static parseYtDlpProgress(
    line: string,
  ): AudioModel.youtubeProgressEvent["data"] | null {
    const full = line.match(
      /\[download\]\s+(\d+\.?\d*)%\s+of\s+~?(\S+)\s+at\s+(\S+)\s+ETA\s+(\S+)/,
    );
    if (full) {
      return {
        percent: parseFloat(full[1]),
        totalSize: full[2],
        speed: full[3],
        eta: full[4],
      };
    }
    const simple = line.match(/\[download\]\s+(\d+\.?\d*)%/);
    if (simple) return { percent: parseFloat(simple[1]) };
    return null;
  }

  private static registerInFlight(
    key: string,
    sendEvent: Emit,
  ): {
    broadcast: Emit;
    resolve: (r: AudioModel.youtubeResponse) => void;
    reject: (e: Error) => void;
  } {
    const subscribers = new Set<Emit>();
    let resolve!: (r: AudioModel.youtubeResponse) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<AudioModel.youtubeResponse>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.inFlightDownloads.set(key, { subscribers, promise });
    const broadcast: Emit = (event) => {
      sendEvent(event);
      for (const sub of subscribers) sub(event);
    };
    return { broadcast, resolve, reject };
  }

  private static async ensureUserLibraryEntry(options: {
    audioFileId: string;
    userId: string;
    playlistId?: string;
    playlistIndex?: number;
  }): Promise<{ alreadyMapped: boolean }> {
    const { audioFileId, userId, playlistId, playlistIndex } = options;
    const existing = await AudioFileUserRepository.findByAudioAndUser(
      audioFileId,
      userId,
    );
    if (!existing) {
      await AudioFileUserRepository.create({
        id: crypto.randomUUID(),
        audioFileId,
        userId,
      });
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
    return { alreadyMapped: !!existing };
  }

  private static async findOrCreateTidalCollectionPlaylist(options: {
    type: "album" | "playlist";
    sourceId: string;
    title: string;
    userId: string;
  }): Promise<string> {
    const { type, sourceId, title, userId } = options;
    const playlistId = `tidal_${type}_${sourceId}_${userId}`;

    const existing = await PlaylistRepository.findById(playlistId);
    if (existing) {
      return existing.id;
    }

    const created = await PlaylistRepository.create({
      id: playlistId,
      name: title,
      userId,
      coverImage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return created.id;
  }

  private static async resolveTidalCollectionCoverImage(options: {
    playlistId: string;
    firstTrackId: number;
  }): Promise<string | null> {
    const { playlistId, firstTrackId } = options;

    const existingPlaylist = await PlaylistRepository.findById(playlistId);
    if (existingPlaylist?.coverImage) {
      return existingPlaylist.coverImage;
    }

    try {
      const firstTrackInfo = await getTidalTrackInfo(firstTrackId);
      if (firstTrackInfo?.albumCoverUrl) {
        const fromTrackInfo = await this.downloadCoverFromUrl(
          firstTrackInfo.albumCoverUrl,
          crypto.randomUUID(),
        );
        if (fromTrackInfo) {
          return fromTrackInfo;
        }
      }
    } catch {
    }

    const firstTrack = await AudioRepository.findByTidalId(
      String(firstTrackId),
    );
    if (!firstTrack) {
      return null;
    }

    if (firstTrack.imageFile) {
      return firstTrack.imageFile;
    }

    const tempAudioPath = join(
      TEMP_DIR,
      `cover_${firstTrack.id}_${firstTrack.filename}`,
    );
    try {
      const audioData = await Storage.download(firstTrack.filename);
      await Bun.write(tempAudioPath, audioData);

      const extractedImage = await AudioService.extractAlbumArt(
        tempAudioPath,
        crypto.randomUUID(),
      );
      if (extractedImage) {
        await AudioRepository.update(firstTrack.id, {
          imageFile: extractedImage,
        });
        return extractedImage;
      }
    } catch (error) {
      logger.error(
        "Failed to resolve Tidal collection cover from first track",
        error,
        {
          context: "TIDAL",
        },
      );
    } finally {
      if (existsSync(tempAudioPath)) {
        try {
          unlinkSync(tempAudioPath);
        } catch {}
      }
    }

    return null;
  }

  private static async embedMetadataWithFfmpeg(
    filePath: string,
    metadata: { title?: string; artist?: string; album?: string },
  ): Promise<void> {
    const outputPath = `${filePath}.tagged.tmp`;
    try {
      const args = ["ffmpeg", "-i", filePath];
      if (metadata.title) args.push("-metadata", `title=${metadata.title}`);
      if (metadata.artist) args.push("-metadata", `artist=${metadata.artist}`);
      if (metadata.album) args.push("-metadata", `album=${metadata.album}`);
      args.push("-c", "copy", "-y", outputPath);
      const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
      const exitCode = await proc.exited;
      if (exitCode === 0 && existsSync(outputPath))
        renameSync(outputPath, filePath);
    } catch {
      logger.warn("Failed to embed metadata with ffmpeg", { context: "TIDAL" });
    } finally {
      if (existsSync(outputPath)) unlinkSync(outputPath);
    }
  }

  private static async downloadCoverFromUrl(
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
        context: "TIDAL",
      });
      return null;
    } finally {
      if (existsSync(tempImagePath)) unlinkSync(tempImagePath);
    }
  }

  static async downloadYoutube(
    url: string,
    userId: string,
    sendEvent: Emit,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      if (signal?.aborted) {
        sendEvent({ type: "cancelled", message: "Download was cancelled" });
        return;
      }
      sendEvent({ type: "info", message: "Checking dependencies..." });
      const check = Bun.spawn(["yt-dlp", "--version"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if ((await check.exited) !== 0)
        throw new Error("yt-dlp is not installed or not accessible");
      if (signal?.aborted) {
        sendEvent({ type: "cancelled", message: "Download was cancelled" });
        return;
      }
      if (url.includes("list=") || url.includes("/playlist")) {
        await this.downloadYoutubePlaylist(url, userId, sendEvent, signal);
      } else {
        await this.downloadYoutubeSingle(
          url,
          userId,
          sendEvent,
          undefined,
          undefined,
          signal,
        );
      }
    } catch (error) {
      if (signal?.aborted) {
        sendEvent({ type: "cancelled", message: "Download was cancelled" });
        return;
      }
      logger.error("YouTube download failed", error, { context: "YOUTUBE" });
      throw new Error(
        error instanceof Error ? error.message : "Unknown error occurred",
      );
    }
  }

  private static async downloadYoutubeSingle(
    url: string,
    userId: string,
    sendEvent: Emit,
    playlistId?: string,
    playlistIndex?: number,
    signal?: AbortSignal,
  ): Promise<AudioModel.youtubeResponse> {
    sendEvent({ type: "info", message: "Checking video..." });
    const videoId = new URL(url).searchParams.get("v");

    if (videoId) {
      const existing = await AudioRepository.findByYoutubeId(videoId);
      if (existing) {
        const { alreadyMapped } = await this.ensureUserLibraryEntry({
          audioFileId: existing.id,
          userId,
          playlistId,
          playlistIndex,
        });
        const result: AudioModel.youtubeResponse = {
          success: true,
          isExisting: true,
          id: existing.id,
          playlistItemId: playlistId ? existing.id : undefined,
          filename: existing.filename,
          title: existing.title || existing.filename,
          imageFile: existing.imageFile || undefined,
          message: alreadyMapped
            ? "Already in your library"
            : "Added to your library",
        };
        if (!playlistId)
          sendEvent({ type: "complete", message: result.message, result });
        return result;
      }

      const inFlight = this.inFlightDownloads.get(videoId);
      if (inFlight) {
        inFlight.subscribers.add(sendEvent);
        sendEvent({
          type: "info",
          message: "Download already in progress, waiting...",
        });
        try {
          const original = await inFlight.promise;
          await this.ensureUserLibraryEntry({
            audioFileId: original.id,
            userId,
            playlistId,
            playlistIndex,
          });
          const result = {
            ...original,
            isExisting: true,
            message: "Added to your library",
          };
          if (!playlistId)
            sendEvent({
              type: "complete",
              message: "Download complete!",
              result,
            });
          return result;
        } finally {
          inFlight.subscribers.delete(sendEvent);
        }
      }
    }

    if (signal?.aborted) throw new Error("Download was cancelled");
    sendEvent({ type: "info", message: "Starting download..." });

    const id = generateId() + "_" + (videoId || "yt");
    const filename = `${id}.opus`;
    const tempFilePath = join(TEMP_DIR, filename);

    let resolveInFlight: (r: AudioModel.youtubeResponse) => void = () => {};
    let rejectInFlight: (e: Error) => void = () => {};

    if (videoId) {
      const { broadcast, resolve, reject } = this.registerInFlight(
        videoId,
        sendEvent,
      );
      resolveInFlight = resolve;
      rejectInFlight = reject;
      sendEvent = broadcast;
    }

    try {
      const proc = Bun.spawn(
        [
          "yt-dlp",
          ...this.ytDlpBaseArgs(this.hasCookies()),
          "--newline",
          "--no-playlist",
          "-o",
          tempFilePath,
          url,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );

      const abortHandler = () => {
        try {
          proc.kill();
        } catch {}
      };
      signal?.addEventListener("abort", abortHandler, { once: true });

      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          if (signal?.aborted) {
            reader.cancel();
            break;
          }
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (line.includes("[download]")) {
              const data = this.parseYtDlpProgress(line);
              if (data)
                sendEvent({
                  type: "progress",
                  message: `Downloading: ${data.percent?.toFixed(1)}%`,
                  data,
                });
            } else if (line.includes("[ExtractAudio]")) {
              sendEvent({ type: "info", message: "Converting audio..." });
            } else if (line.includes("[EmbedThumbnail]")) {
              sendEvent({ type: "info", message: "Embedding thumbnail..." });
            }
          }
        }
      } finally {
        signal?.removeEventListener("abort", abortHandler);
      }

      if (signal?.aborted) {
        if (existsSync(tempFilePath)) unlinkSync(tempFilePath);
        throw new Error("Download was cancelled");
      }

      if ((await proc.exited) !== 0) {
        const stderr = await new Response(proc.stderr).text();
        logger.error("yt-dlp failed", new Error(stderr), {
          context: "YOUTUBE",
        });
        throw new Error(`Download failed: ${stderr.substring(0, 200)}`);
      }

      sendEvent({ type: "info", message: "Processing file..." });
      const stats = await stat(tempFilePath);
      const [extractedMetadata, extractedImage] = await Promise.all([
        AudioService.extractMetadata(tempFilePath),
        AudioService.extractAlbumArt(tempFilePath, id),
      ]);

      await Storage.uploadFromFile(
        filename,
        tempFilePath,
        AudioService.getAudioContentType(".opus"),
      );
      if (existsSync(tempFilePath)) unlinkSync(tempFilePath);

      await AudioRepository.create(
        AudioRepository.fromMetadata(
          id,
          filename,
          stats.size,
          extractedMetadata ?? undefined,
          extractedImage ?? undefined,
          videoId || undefined,
        ),
      );
      await this.ensureUserLibraryEntry({
        audioFileId: id,
        userId,
        playlistId,
        playlistIndex,
      });

      const result: AudioModel.youtubeResponse = {
        success: true,
        id,
        filename,
        title: extractedMetadata?.title || filename,
        imageFile: extractedImage || undefined,
        message: "YouTube audio downloaded successfully",
      };
      resolveInFlight(result);
      if (!playlistId)
        sendEvent({ type: "complete", message: "Download complete!", result });
      return result;
    } catch (error) {
      rejectInFlight(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      if (videoId) this.inFlightDownloads.delete(videoId);
    }
  }

  private static async downloadYoutubePlaylist(
    url: string,
    userId: string,
    sendEvent: Emit,
    signal?: AbortSignal,
  ): Promise<void> {
    sendEvent({ type: "info", message: "Playlist detected, fetching info..." });
    const cookies = this.hasCookies();

    const infoProc = Bun.spawn(
      [
        "yt-dlp",
        ...(cookies ? ["--cookies", "cookies.txt"] : []),
        "--user-agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        "--ignore-errors",
        "--dump-json",
        "--flat-playlist",
        url,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    const abortHandler = () => {
      try {
        infoProc.kill();
      } catch {}
    };
    signal?.addEventListener("abort", abortHandler, { once: true });
    const infoExitCode = await infoProc.exited;
    signal?.removeEventListener("abort", abortHandler);

    if (signal?.aborted) throw new Error("Download was cancelled");

    const stdout = await new Response(infoProc.stdout).text();
    const stderr = await new Response(infoProc.stderr).text();

    if (infoExitCode !== 0 && stderr.trim()) {
      logger.warn(`yt-dlp playlist info stderr: ${stderr.substring(0, 300)}`, {
        context: "YOUTUBE",
      });
    }

    const videos = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          logger.warn(`Skipping non-JSON line: ${line.substring(0, 120)}`, {
            context: "YOUTUBE",
          });
          return [];
        }
      });

    if (videos.length === 0) {
      if (infoExitCode !== 0 && stderr.trim()) {
        throw new Error(
          `Failed to fetch playlist info: ${stderr.substring(0, 200)}`,
        );
      }
      throw new Error("No videos found in playlist");
    }

    const playlistId = videos[0].playlist_id || videos[0].id;
    const playlistTitle =
      videos[0].playlist_title || videos[0].title || "YouTube Playlist";

    sendEvent({
      type: "info",
      message: `Found ${videos.length} videos in playlist: ${playlistTitle}`,
      playlistTitle,
      playlistTotal: videos.length,
    });
    logger.info(
      `Downloading ${videos.length} videos from playlist: ${playlistTitle}`,
      { context: "YOUTUBE" },
    );

    const youtubePlaylistId = `youtube_${playlistId}`;
    const dbPlaylistId = await PlaylistService.findOrCreateYoutubePlaylist(
      playlistId,
      playlistTitle,
      userId,
    );
    const existingPlaylist = await PlaylistRepository.findById(dbPlaylistId);

    sendEvent({
      type: "info",
      message: `Starting to download ${videos.length} videos...`,
      playlistTitle,
      playlistTotal: videos.length,
    });

    const results = [];
    for (let index = 0; index < videos.length; index++) {
      if (signal?.aborted) {
        sendEvent({
          type: "cancelled",
          message: `Playlist download cancelled after ${index} of ${videos.length} videos`,
          playlistTitle,
          playlistTotal: videos.length,
          playlistCurrent: index,
        });
        return;
      }

      const video = videos[index];
      const videoTitle = video.title || "Unknown";
      const videoUrl =
        video.url || `https://www.youtube.com/watch?v=${video.id}`;

      sendEvent({
        type: "info",
        message: `[${index + 1}/${videos.length}] Downloading: ${videoTitle}`,
        playlistTitle,
        playlistTotal: videos.length,
        playlistCurrent: index + 1,
        videoTitle,
      });

      try {
        const result = await this.downloadYoutubeSingle(
          videoUrl,
          userId,
          sendEvent,
          dbPlaylistId,
          video.playlist_index,
          signal,
        );
        results.push({
          ...result,
          message: result.message || "Downloaded successfully",
        });
        sendEvent({
          type: "info",
          message: `✓ Completed: ${videoTitle}`,
          playlistTitle,
          playlistTotal: videos.length,
          playlistCurrent: index + 1,
          videoTitle,
        });
      } catch (error: any) {
        const message = error.message || "Unknown error occurred";
        logger.error(`Failed to download video: ${videoTitle}`, error, {
          context: "YOUTUBE",
        });
        results.push({
          success: false as const,
          title: videoTitle,
          error: message,
        });
        sendEvent({
          type: "info",
          message: `✗ Failed: ${videoTitle} - ${message}`,
          playlistTitle,
          playlistTotal: videos.length,
          playlistCurrent: index + 1,
          videoTitle,
        });
      }

      if (index < videos.length - 1 && !results[index].isExisting) {
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 2000);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timeout);
              resolve();
            },
            { once: true },
          );
        });
      }
    }

    const successfulDownloads = results.filter((r) => r.success).length;
    const failedDownloads = results.filter((r) => !r.success).length;
    const allSuccessful = failedDownloads === 0;

    let playlistCoverImage: string | null =
      existingPlaylist?.coverImage || null;
    if (!playlistCoverImage && successfulDownloads > 0) {
      for (let index = 0; index < videos.length; index++) {
        const position = videos[index].playlist_index
          ? videos[index].playlist_index - 1
          : index;
        const result = results[index];
        if (position === 0 && result.success && "id" in result && result.id) {
          try {
            const audioFile = await AudioRepository.findById(result.id);
            if (audioFile) {
              const tempAudioPath = join(TEMP_DIR, audioFile.filename);
              if (!existsSync(tempAudioPath)) {
                await Bun.write(
                  tempAudioPath,
                  await Storage.download(audioFile.filename),
                );
              }
              playlistCoverImage = await AudioService.extractAlbumArt(
                tempAudioPath,
                crypto.randomUUID(),
              );
            }
          } catch (error) {
            logger.error(
              "Failed to extract album art for playlist cover",
              error,
              { context: "YOUTUBE" },
            );
          }
          break;
        }
      }
    }

    if (
      playlistCoverImage &&
      playlistCoverImage !== existingPlaylist?.coverImage
    ) {
      await PlaylistRepository.update(dbPlaylistId, {
        coverImage: playlistCoverImage,
      });
    }

    logger.info(
      `Playlist download completed: ${successfulDownloads}/${videos.length} successful`,
      { context: "YOUTUBE" },
    );

    const message = allSuccessful
      ? `Successfully downloaded all ${successfulDownloads} videos from playlist`
      : `Downloaded ${successfulDownloads} of ${videos.length} videos. ${failedDownloads} failed.`;

    sendEvent({
      type: "complete",
      message,
      result: {
        success: true,
        isPlaylist: true as const,
        playlistId: youtubePlaylistId,
        playlistTitle,
        results,
        totalVideos: videos.length,
        successfulDownloads,
        failedDownloads,
        message,
      },
    });
  }

  private static async downloadTidalTrack(
    trackId: number,
    quality: string,
    userId: string,
    sendEvent: Emit,
    signal?: AbortSignal,
    options?: {
      emitComplete?: boolean;
      playlistId?: string;
      playlistIndex?: number;
    },
  ): Promise<AudioModel.youtubeResponse> {
    const emitComplete = options?.emitComplete ?? true;
    const playlistId = options?.playlistId;
    const playlistIndex = options?.playlistIndex;

    const trackIdStr = String(trackId);
    sendEvent({ type: "info", message: "Checking for existing file..." });

    const existing = await AudioRepository.findByTidalId(trackIdStr);
    if (existing) {
      const { alreadyMapped } = await this.ensureUserLibraryEntry({
        audioFileId: existing.id,
        userId,
        playlistId,
        playlistIndex,
      });
      const result: AudioModel.youtubeResponse = {
        success: true,
        isExisting: true,
        id: existing.id,
        filename: existing.filename,
        title: existing.title || existing.filename,
        imageFile: existing.imageFile || undefined,
        message: alreadyMapped
          ? "Already in your library"
          : "Added to your library",
      };
      if (emitComplete) {
        sendEvent({ type: "complete", message: result.message, result });
      }
      return result;
    }

    const inFlightKey = `tidal:${trackIdStr}`;
    const inFlight = this.inFlightDownloads.get(inFlightKey);
    if (inFlight) {
      inFlight.subscribers.add(sendEvent);
      sendEvent({
        type: "info",
        message: "Download already in progress, waiting...",
      });
      try {
        const original = await inFlight.promise;
        await this.ensureUserLibraryEntry({
          audioFileId: original.id,
          userId,
          playlistId,
          playlistIndex,
        });
        const result: AudioModel.youtubeResponse = {
          ...original,
          isExisting: true,
          message: "Added to your library",
        };
        if (emitComplete) {
          sendEvent({
            type: "complete",
            message: "Download complete!",
            result,
          });
        }
        return result;
      } finally {
        inFlight.subscribers.delete(sendEvent);
      }
    }

    if (signal?.aborted) throw new Error("Download was cancelled");

    sendEvent({ type: "info", message: "Fetching download URL from Tidal..." });

    const {
      broadcast,
      resolve: resolveInFlight,
      reject: rejectInFlight,
    } = this.registerInFlight(inFlightKey, sendEvent);
    sendEvent = broadcast;

    const id = generateId() + "_tidal";
    const trackInfoPromise = getTidalTrackInfo(trackId);
    let tempFilePath: string | null = null;

    try {
      const downloadInfo = await getDownloadUrl(trackId, quality, signal);
      if (signal?.aborted) throw new Error("Download was cancelled");
      sendEvent({ type: "info", message: "Starting download..." });

      const onProgress = (downloaded: number, total: number) => {
        const pct = total > 0 ? (downloaded / total) * 100 : 0;
        sendEvent({
          type: "progress",
          message: `Downloading: ${pct.toFixed(1)}%`,
          data: { percent: pct },
        });
      };
      const onDashProgress = (current: number, total: number) => {
        const pct = (current / total) * 100;
        sendEvent({
          type: "progress",
          message: `Downloading segment ${current}/${total}`,
          data: { percent: pct },
        });
      };

      let ext: string;
      if (downloadInfo.url.startsWith("MANIFEST:")) {
        const parsed = parseManifest(
          downloadInfo.url.slice("MANIFEST:".length),
        );
        if (parsed.type === "direct") {
          ext = quality === "HIGH" ? ".m4a" : ".flac";
          tempFilePath = join(TEMP_DIR, `${id}${ext}`);
          await downloadDirectToFile(
            parsed.url,
            tempFilePath,
            onProgress,
            signal,
          );
        } else {
          ext = ".m4a";
          tempFilePath = join(TEMP_DIR, `${id}${ext}`);
          await downloadDashToFile(
            parsed.initUrl,
            parsed.mediaUrls,
            tempFilePath,
            onDashProgress,
            signal,
          );
        }
      } else {
        ext = quality === "HIGH" ? ".m4a" : ".flac";
        tempFilePath = join(TEMP_DIR, `${id}${ext}`);
        await downloadDirectToFile(
          downloadInfo.url,
          tempFilePath,
          onProgress,
          signal,
        );
      }

      if (signal?.aborted) throw new Error("Download was cancelled");
      sendEvent({ type: "info", message: "Processing file..." });

      const trackInfo = await trackInfoPromise;
      if (trackInfo) {
        await this.embedMetadataWithFfmpeg(tempFilePath, {
          title: trackInfo.title,
          artist: trackInfo.artist,
        });
      }

      const [stats, extractedMetadata] = await Promise.all([
        stat(tempFilePath),
        AudioService.extractMetadata(tempFilePath),
      ]);

      let finalMetadata: AudioModel.audioMetadata | undefined;
      if (extractedMetadata) {
        finalMetadata = {
          ...extractedMetadata,
          title: extractedMetadata.title || trackInfo?.title,
          artist: extractedMetadata.artist || trackInfo?.artist,
        };
      } else if (trackInfo) {
        finalMetadata = { title: trackInfo.title, artist: trackInfo.artist };
      }

      let extractedImage = trackInfo?.albumCoverUrl
        ? await this.downloadCoverFromUrl(trackInfo.albumCoverUrl, id)
        : null;
      if (!extractedImage) {
        extractedImage = await AudioService.extractAlbumArt(tempFilePath, id);
      }

      const storageFilename = `${id}${ext}`;
      await Storage.uploadFromFile(
        storageFilename,
        tempFilePath,
        AudioService.getAudioContentType(ext),
      );
      await AudioRepository.create(
        AudioRepository.fromMetadata(
          id,
          storageFilename,
          stats.size,
          finalMetadata,
          extractedImage ?? undefined,
          undefined,
          trackIdStr,
        ),
      );
      await this.ensureUserLibraryEntry({
        audioFileId: id,
        userId,
        playlistId,
        playlistIndex,
      });

      const result: AudioModel.youtubeResponse = {
        success: true,
        id,
        filename: storageFilename,
        title: finalMetadata?.title || storageFilename,
        imageFile: extractedImage || undefined,
        message: "Tidal audio downloaded successfully",
      };

      resolveInFlight(result);
      if (emitComplete) {
        sendEvent({ type: "complete", message: "Download complete!", result });
      }
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (signal?.aborted || err.message.includes("cancelled")) {
        if (emitComplete) {
          sendEvent({ type: "cancelled", message: "Download was cancelled" });
        }
        rejectInFlight(err);
        throw err;
      }
      logger.error("Tidal download failed", error, { context: "TIDAL" });
      rejectInFlight(err);
      throw err;
    } finally {
      this.inFlightDownloads.delete(inFlightKey);
      if (tempFilePath && existsSync(tempFilePath)) {
        try {
          unlinkSync(tempFilePath);
        } catch {}
      }
    }
  }

  static async downloadTidal(
    url: string,
    quality: string,
    userId: string,
    sendEvent: Emit,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) {
      sendEvent({ type: "cancelled", message: "Download was cancelled" });
      return;
    }

    let resource: ReturnType<typeof parseTidalResourceUrl>;
    try {
      resource = parseTidalResourceUrl(url);
    } catch (e) {
      throw new Error(
        `Invalid Tidal URL: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    if (resource.type === "track") {
      const trackId = parseInt(resource.id, 10);
      await this.downloadTidalTrack(
        trackId,
        quality,
        userId,
        sendEvent,
        signal,
        { emitComplete: true },
      );
      return;
    }

    sendEvent({
      type: "info",
      message: `Resolving tracks from Tidal ${resource.type}...`,
    });

    const collection = await getTidalCollectionInfo(
      resource.type,
      resource.id,
      signal,
    );

    const playlistTitle = collection.title || `Tidal ${resource.type}`;
    const totalTracks = collection.trackIds.length;
    if (totalTracks === 0) {
      throw new Error(`No tracks found in Tidal ${resource.type}`);
    }

    const playlistId = await this.findOrCreateTidalCollectionPlaylist({
      type: resource.type,
      sourceId: resource.id,
      title: playlistTitle,
      userId,
    });

    sendEvent({
      type: "info",
      message: `Found ${totalTracks} tracks in ${playlistTitle}`,
      playlistTitle,
      playlistTotal: totalTracks,
    });

    const results: AudioModel.youtubePlaylistResponse["results"] = [];

    for (let index = 0; index < totalTracks; index++) {
      if (signal?.aborted) {
        sendEvent({
          type: "cancelled",
          message: `Download cancelled after ${index} of ${totalTracks} tracks`,
          playlistTitle,
          playlistTotal: totalTracks,
          playlistCurrent: index,
        });
        return;
      }

      const trackId = collection.trackIds[index];
      sendEvent({
        type: "info",
        message: `[${index + 1}/${totalTracks}] Downloading track ${trackId}`,
        playlistTitle,
        playlistTotal: totalTracks,
        playlistCurrent: index + 1,
      });

      try {
        const trackResult = await this.downloadTidalTrack(
          trackId,
          quality,
          userId,
          sendEvent,
          signal,
          {
            emitComplete: false,
            playlistId,
            playlistIndex: index + 1,
          },
        );
        results.push(trackResult);
        sendEvent({
          type: "info",
          message: `✓ Completed ${index + 1}/${totalTracks}`,
          playlistTitle,
          playlistTotal: totalTracks,
          playlistCurrent: index + 1,
        });
      } catch (error: any) {
        const message =
          error instanceof Error
            ? error.message
            : error?.message || "Unknown error occurred";

        if (signal?.aborted || message.toLowerCase().includes("cancelled")) {
          sendEvent({
            type: "cancelled",
            message: `Download cancelled after ${index} of ${totalTracks} tracks`,
            playlistTitle,
            playlistTotal: totalTracks,
            playlistCurrent: index,
          });
          return;
        }

        logger.error(
          `Failed to download Tidal ${resource.type} track ${trackId}`,
          error,
          { context: "TIDAL" },
        );

        results.push({
          success: false,
          title: `Track ${trackId}`,
          error: message,
        });

        sendEvent({
          type: "info",
          message: `✗ Failed ${index + 1}/${totalTracks}: ${message}`,
          playlistTitle,
          playlistTotal: totalTracks,
          playlistCurrent: index + 1,
        });
      }
    }

    const successfulDownloads = results.filter(
      (result) => result.success,
    ).length;
    const failedDownloads = results.filter((result) => !result.success).length;
    const allSuccessful = failedDownloads === 0;

    let playlistCoverImage = await this.resolveTidalCollectionCoverImage({
      playlistId,
      firstTrackId: collection.trackIds[0],
    });

    if (!playlistCoverImage) {
      const fallbackImage = results.find(
        (result): result is AudioModel.youtubeResponse =>
          !!result.success &&
          "imageFile" in result &&
          typeof result.imageFile === "string" &&
          result.imageFile.length > 0,
      );
      playlistCoverImage = fallbackImage?.imageFile ?? null;
    }

    if (playlistCoverImage) {
      await PlaylistRepository.update(playlistId, {
        coverImage: playlistCoverImage,
      });
    }

    const message = allSuccessful
      ? `Successfully downloaded all ${successfulDownloads} tracks from ${playlistTitle}`
      : `Downloaded ${successfulDownloads} of ${totalTracks} tracks. ${failedDownloads} failed.`;

    sendEvent({
      type: "complete",
      message,
      result: {
        success: true,
        isPlaylist: true,
        playlistId: playlistId ?? `tidal_${resource.type}_${resource.id}`,
        playlistTitle,
        results,
        totalVideos: totalTracks,
        successfulDownloads,
        failedDownloads,
        message,
      },
    });
  }
}
