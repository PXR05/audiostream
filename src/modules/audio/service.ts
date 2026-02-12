import { status } from "elysia";
import { existsSync, unlinkSync } from "fs";
import { stat, rename } from "fs/promises";
import { join, extname } from "path";
import * as mm from "music-metadata";
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
  ALLOWED_AUDIO_EXTENSIONS,
  MAX_FILE_SIZE,
  getWebPImageFileName,
} from "../../utils/helpers";
import { logger } from "../../utils/logger";
import { PlaylistService } from "../playlist/service";
import { Storage } from "../../utils/storage";

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
  private static inFlightDownloads = new Map<
    string,
    {
      subscribers: Set<(event: AudioModel.youtubeProgressEvent) => void>;
      promise: Promise<AudioModel.youtubeResponse>;
    }
  >();

  private static async ensureUserLibraryEntry(options: {
    audioFileId: string;
    userId: string;
    playlistId?: string;
    playlistIndex?: number;
  }): Promise<{ alreadyMapped: boolean }> {
    const { audioFileId, userId, playlistId, playlistIndex } = options;

    const existingMapping = await AudioFileUserRepository.findByAudioAndUser(
      audioFileId,
      userId,
    );
    if (!existingMapping) {
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

    return { alreadyMapped: !!existingMapping };
  }

  private static parseYtDlpProgress(
    line: string,
  ): AudioModel.youtubeProgressEvent["data"] | null {
    const downloadMatch = line.match(
      /\[download\]\s+(\d+\.?\d*)%\s+of\s+~?(\S+)\s+at\s+(\S+)\s+ETA\s+(\S+)/,
    );
    if (downloadMatch) {
      return {
        percent: parseFloat(downloadMatch[1]),
        totalSize: downloadMatch[2],
        speed: downloadMatch[3],
        eta: downloadMatch[4],
      };
    }

    const simplePercentMatch = line.match(/\[download\]\s+(\d+\.?\d*)%/);
    if (simplePercentMatch) {
      return {
        percent: parseFloat(simplePercentMatch[1]),
      };
    }

    return null;
  }

  private static getYtDlpBaseArgs(hasCookies: boolean): string[] {
    return [
      ...(hasCookies ? ["--cookies", "cookies.txt"] : []),
      "--extractor-args",
      "youtube:player_client=default,tv_simply,tv,android_vr",
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

  private static async cropAndReembedThumbnail(
    filePath: string,
  ): Promise<void> {
    try {
      const ext = extname(filePath).toLowerCase();
      const tempImagePath = join(TEMP_DIR, `temp_thumb_${Date.now()}.jpg`);
      const tempAudioPath = join(TEMP_DIR, `temp_audio_${Date.now()}${ext}`);

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
          tempImagePath,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      await extractProc.exited;

      if (!existsSync(tempImagePath)) {
        logger.warn("No embedded thumbnail found to crop", {
          context: "AUDIO",
        });
        return;
      }

      const image = await jimp.read(tempImagePath);
      const width = image.getWidth();
      const height = image.getHeight();
      const size = Math.min(width, height);
      const x = Math.floor((width - size) / 2);
      const y = Math.floor((height - size) / 2);

      const croppedImagePath = join(
        TEMP_DIR,
        `cropped_thumb_${Date.now()}.jpg`,
      );
      await image
        .crop(x, y, size, size)
        .quality(95)
        .writeAsync(croppedImagePath);

      const ffmpegArgs = [
        "ffmpeg",
        "-i",
        filePath,
        "-i",
        croppedImagePath,
        "-map",
        "0:a",
        "-map",
        "1:0",
        "-c",
        "copy",
      ];

      if (ext === ".mp3") {
        ffmpegArgs.push("-id3v2_version", "3");
      }

      ffmpegArgs.push(
        "-metadata:s:v",
        "title=Album cover",
        "-metadata:s:v",
        "comment=Cover (front)",
        "-y",
        tempAudioPath,
      );

      const embedProc = Bun.spawn(ffmpegArgs, {
        stdout: "pipe",
        stderr: "pipe",
      });
      const embedExit = await embedProc.exited;

      if (embedExit === 0 && existsSync(tempAudioPath)) {
        unlinkSync(filePath);
        await rename(tempAudioPath, filePath);
        logger.info("Successfully cropped and re-embedded thumbnail", {
          context: "AUDIO",
        });
      }
      if (existsSync(tempImagePath)) unlinkSync(tempImagePath);
      if (existsSync(croppedImagePath)) unlinkSync(croppedImagePath);
      if (existsSync(tempAudioPath)) unlinkSync(tempAudioPath);
    } catch (error) {
      logger.error("Failed to crop and re-embed thumbnail", error, {
        context: "AUDIO",
      });
    }
  }

  static async extractMetadata(
    filePath: string,
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
      const metadata = await mm.parseFile(filePath);
      const pictures = metadata.common.picture ?? [];

      for (const picture of pictures) {
        try {
          const image = await jimp.read(Buffer.from(picture.data));
          await image.quality(100).writeAsync(tempImagePath);

          const imageData = await Bun.file(tempImagePath).arrayBuffer();
          await Storage.upload(
            webpImageFileName,
            new Uint8Array(imageData),
            "image/webp",
          );

          return webpImageFileName;
        } catch (error) {
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

      if (!existsSync(fallbackCoverPath)) {
        return null;
      }

      const fallbackImage = await jimp.read(fallbackCoverPath);
      await fallbackImage.quality(100).writeAsync(tempImagePath);

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

  static async getAudioFiles(options: {
    userId: string;
    page?: number;
    limit?: number;
    sortBy?: "filename" | "size" | "uploadedAt" | "title";
    sortOrder?: "asc" | "desc";
    lastFetchedAt?: number;
  }): Promise<AudioModel.audioListResponse> {
    const {
      page = 1,
      limit = 20,
      sortBy = "uploadedAt",
      sortOrder = "desc",
      userId,
      lastFetchedAt,
    } = options;

    const { files: dbFiles, total } = await AudioRepository.findAll({
      page,
      limit,
      sortBy,
      sortOrder,
      userId,
      lastFetchedAt,
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

  static async uploadFile(
    file: File,
    userId: string,
  ): Promise<AudioModel.uploadResponse> {
    if (!file) {
      throw status(400, "No file provided");
    }

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
      const extractedImage = await this.extractAlbumArt(tempFilePath, id);
      const extractedMetadata = await this.extractMetadata(tempFilePath);

      const contentType = this.getAudioContentType(ext);
      await Storage.uploadFromFile(filename, tempFilePath, contentType);

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

  private static getAudioContentType(ext: string): string {
    const types: Record<string, string> = {
      ".mp3": "audio/mpeg",
      ".opus": "audio/opus",
      ".wav": "audio/wav",
      ".flac": "audio/flac",
      ".m4a": "audio/mp4",
      ".aac": "audio/aac",
      ".ogg": "audio/ogg",
    };
    return types[ext] || "application/octet-stream";
  }

  static async uploadFiles(
    files: File[],
    userId: string,
  ): Promise<AudioModel.multiUploadResponse> {
    if (!files || files.length === 0) {
      throw status(400, "No files provided");
    }

    const uploadPromises = files.map(async (file) => {
      try {
        const result = await this.uploadFile(file, userId);
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

  static async getAudioById(
    id: string,
    userId: string,
  ): Promise<AudioModel.audioFile> {
    const dbFile = await AudioRepository.findById(id, userId);

    if (!dbFile) {
      throw status(404, "Audio file not found");
    }

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
        const imageExists = await Storage.exists(file.imageFile);
        if (imageExists) {
          await Storage.delete(file.imageFile);
        }
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
    if (!metadata) {
      throw status(404, "File not found in storage");
    }

    return {
      file,
      size: metadata.size,
      contentType: metadata.contentType,
    };
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

    if (!file.imageFile) {
      throw status(404, "No image file found for this audio");
    }

    const exists = await Storage.exists(file.imageFile);
    if (!exists) {
      throw status(404, "Image not found in storage");
    }

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
    options: {
      page?: number;
      limit?: number;
      userId: string;
    },
  ): Promise<AudioModel.audioListResponse> {
    const { page = 1, limit = 20, userId } = options;

    const { files: dbFiles, total } = await AudioRepository.search(query, {
      page,
      limit,
      userId,
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
    limit: number = 5,
  ): Promise<AudioModel.searchSuggestionsResponse> {
    const suggestions = await AudioRepository.searchSuggestions(query, limit);
    return { suggestions };
  }

  static async searchYoutube(
    query: string,
  ): Promise<AudioModel.youtubeSearchResponse> {
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) {
      throw new Error("YOUTUBE_API_KEY is not configured");
    }

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

    if (!response.ok) {
      throw new Error(`YouTube API error: ${await response.text()}`);
    }

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
      const firstTrackIndex = shuffledFiles.findIndex(
        (file) => file.id === firstTrackId,
      );

      if (firstTrackIndex !== -1) {
        const [firstTrack] = shuffledFiles.splice(firstTrackIndex, 1);
        shuffledFiles.unshift(firstTrack);
      }
    }

    const total = shuffledFiles.length;
    const offset = (page - 1) * limit;
    const paginatedFiles = shuffledFiles.slice(offset, offset + limit);

    const files = paginatedFiles.map((dbFile) =>
      AudioRepository.toAudioModel(dbFile),
    );

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

  static async downloadYoutube(
    url: string,
    userId: string,
    sendEvent: (event: AudioModel.youtubeProgressEvent) => void,
  ): Promise<void> {
    try {
      sendEvent({
        type: "info",
        message: "Checking dependencies...",
      });

      const checkProc = Bun.spawn(["yt-dlp", "--version"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const checkExit = await checkProc.exited;
      if (checkExit !== 0) {
        throw new Error("yt-dlp is not installed or not accessible");
      }

      const isPlaylist = url.includes("list=") || url.includes("/playlist");

      if (isPlaylist) {
        await this.downloadYoutubePlaylist(url, userId, sendEvent);
      } else {
        await this.downloadYoutubeSingle(url, userId, sendEvent);
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error occurred";
      logger.error("YouTube download failed", error, {
        context: "YOUTUBE",
      });
      throw new Error(errorMessage);
    }
  }

  private static async downloadYoutubeSingle(
    url: string,
    userId: string,
    sendEvent: (event: AudioModel.youtubeProgressEvent) => void,
    playlistId?: string,
    playlistIndex?: number,
  ): Promise<AudioModel.youtubeResponse> {
    sendEvent({
      type: "info",
      message: "Checking video...",
    });

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

        if (!playlistId) {
          sendEvent({
            type: "complete",
            message: result.message,
            result,
          });
        }

        return result;
      }

      const inFlight = this.inFlightDownloads.get(videoId);
      if (inFlight) {
        logger.info(`Subscribing to in-flight download for video ${videoId}`, {
          context: "YOUTUBE",
        });

        inFlight.subscribers.add(sendEvent);

        sendEvent({
          type: "info",
          message: "Download already in progress, waiting...",
        });

        try {
          const originalResult = await inFlight.promise;

          await this.ensureUserLibraryEntry({
            audioFileId: originalResult.id,
            userId,
            playlistId,
            playlistIndex,
          });

          const subscriberResult: AudioModel.youtubeResponse = {
            ...originalResult,
            isExisting: true,
            message: "Added to your library",
          };

          if (!playlistId) {
            sendEvent({
              type: "complete",
              message: "Download complete!",
              result: subscriberResult,
            });
          }

          return subscriberResult;
        } finally {
          inFlight.subscribers.delete(sendEvent);
        }
      }
    }

    sendEvent({
      type: "info",
      message: "Starting download...",
    });

    const id = generateId() + "_" + (videoId || "yt");
    const downloadExt = ".opus";
    const filename = `${id}${downloadExt}`;
    const tempFilePath = join(TEMP_DIR, filename);

    let hasCookies = false;
    try {
      hasCookies = existsSync("cookies.txt");
    } catch (error) {
      logger.error("Error checking for cookies.txt", error);
    }

    const subscribers = new Set<
      (event: AudioModel.youtubeProgressEvent) => void
    >();
    let resolveInFlight!: (result: AudioModel.youtubeResponse) => void;
    let rejectInFlight!: (error: Error) => void;

    if (videoId) {
      const inFlightPromise = new Promise<AudioModel.youtubeResponse>(
        (resolve, reject) => {
          resolveInFlight = resolve;
          rejectInFlight = reject;
        },
      );
      this.inFlightDownloads.set(videoId, {
        subscribers,
        promise: inFlightPromise,
      });
    }

    const originalSendEvent = sendEvent;
    sendEvent = (event: AudioModel.youtubeProgressEvent) => {
      originalSendEvent(event);
      for (const subscriber of subscribers) {
        subscriber(event);
      }
    };

    try {
      const ytDlpArgs = [
        ...this.getYtDlpBaseArgs(hasCookies),
        "--newline",
        "--no-playlist",
        "-o",
        tempFilePath,
        url,
      ];

      const proc = Bun.spawn(["yt-dlp", ...ytDlpArgs], {
        stdout: "pipe",
        stderr: "pipe",
      });

      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.includes("[download]")) {
            const progressData = this.parseYtDlpProgress(line);
            if (progressData) {
              sendEvent({
                type: "progress",
                message: `Downloading: ${progressData.percent?.toFixed(1)}%`,
                data: progressData,
              });
            }
          } else if (line.includes("[ExtractAudio]")) {
            sendEvent({
              type: "info",
              message: "Converting audio...",
            });
          } else if (line.includes("[EmbedThumbnail]")) {
            sendEvent({
              type: "info",
              message: "Embedding thumbnail...",
            });
          }
        }
      }

      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        logger.error("yt-dlp failed", new Error(stderr), {
          context: "YOUTUBE",
        });
        throw new Error(`Download failed: ${stderr.substring(0, 200)}`);
      }

      sendEvent({
        type: "info",
        message: "Processing file...",
      });

      await this.cropAndReembedThumbnail(tempFilePath);

      const stats = await stat(tempFilePath);
      const extractedMetadata = await this.extractMetadata(tempFilePath);
      const extractedImage = await this.extractAlbumArt(tempFilePath, id);

      const contentType = this.getAudioContentType(downloadExt);
      await Storage.uploadFromFile(filename, tempFilePath, contentType);
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

      if (videoId) {
        resolveInFlight(result);
      }

      if (!playlistId) {
        sendEvent({
          type: "complete",
          message: "Download complete!",
          result,
        });
      }

      return result;
    } catch (error) {
      if (videoId) {
        rejectInFlight(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      throw error;
    } finally {
      if (videoId) {
        this.inFlightDownloads.delete(videoId);
      }
    }
  }

  private static async downloadYoutubePlaylist(
    url: string,
    userId: string,
    sendEvent: (event: AudioModel.youtubeProgressEvent) => void,
  ): Promise<void> {
    sendEvent({
      type: "info",
      message: "Playlist detected, fetching info...",
    });

    let hasCookies = false;
    try {
      hasCookies = existsSync("cookies.txt");
    } catch (error) {
      logger.error("Error checking for cookies.txt", error);
    }

    if (hasCookies) {
      logger.info(`Using cookies in cookies.txt`);
    }

    logger.info(`Fetching YouTube playlist info: ${url}`, {
      context: "YOUTUBE",
    });

    const infoArgs = [
      ...(hasCookies ? ["--cookies", "cookies.txt"] : []),
      "--user-agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      "--dump-json",
      "--flat-playlist",
      url,
    ];

    const infoProc = Bun.spawn(["yt-dlp", ...infoArgs], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const infoExitCode = await infoProc.exited;

    if (infoExitCode !== 0) {
      const stderr = await new Response(infoProc.stderr).text();
      throw new Error(
        `Failed to fetch playlist info: ${stderr.substring(0, 200)}`,
      );
    }

    const stdout = await new Response(infoProc.stdout).text();
    const lines = stdout.trim().split("\n");
    const videos = lines.map((line) => JSON.parse(line));

    logger.info(JSON.stringify(videos, null, 2));

    if (videos.length === 0) {
      throw new Error("No videos found in playlist");
    }

    const playlistInfo = videos[0];
    const playlistId = playlistInfo.playlist_id || playlistInfo.id;
    const playlistTitle =
      playlistInfo.playlist_title || playlistInfo.title || "YouTube Playlist";

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

    logger.info(`Starting to download ${videos.length} videos one by one`, {
      context: "YOUTUBE",
    });

    const results = [];
    for (let index = 0; index < videos.length; index++) {
      const video = videos[index];
      const videoId = video.id;
      const videoTitle = video.title || "Unknown";
      const videoUrl =
        video.url || `https://www.youtube.com/watch?v=${videoId}`;

      sendEvent({
        type: "info",
        message: `[${index + 1}/${videos.length}] Downloading: ${videoTitle}`,
        playlistTitle,
        playlistTotal: videos.length,
        playlistCurrent: index + 1,
        videoTitle,
      });

      logger.info(
        `\n[${index + 1}/${videos.length}] Downloading: ${videoTitle}`,
      );
      logger.info(
        `Downloading video ${index + 1}/${videos.length}: ${videoTitle}`,
        { context: "YOUTUBE" },
      );

      try {
        const result = await this.downloadYoutubeSingle(
          videoUrl,
          userId,
          sendEvent,
          dbPlaylistId,
          video.playlist_index,
        );

        logger.info(`✓ Successfully added to database`);
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
        const errorMessage = error.message || "Unknown error occurred";
        logger.error(`Failed to download video: ${videoTitle}`, error, {
          context: "YOUTUBE",
        });

        results.push({
          success: false as const,
          title: videoTitle,
          error: errorMessage,
        });

        sendEvent({
          type: "info",
          message: `✗ Failed: ${videoTitle} - ${errorMessage}`,
          playlistTitle,
          playlistTotal: videos.length,
          playlistCurrent: index + 1,
          videoTitle,
        });
      }

      if (index < videos.length - 1 && !results[index].isExisting) {
        const delaySeconds = 2;
        sendEvent({
          type: "info",
          message: `Waiting ${delaySeconds} seconds before next download...`,
        });
        await new Promise((resolve) =>
          setTimeout(resolve, delaySeconds * 1000),
        );
      }
    }

    logger.info(`\nPlaylist download complete!`);

    const successfulDownloads = results.filter((r) => r.success).length;
    const failedDownloads = results.filter((r) => !r.success).length;
    const totalVideos = videos.length;
    const allSuccessful = failedDownloads === 0;

    let playlistCoverImage: string | null =
      existingPlaylist?.coverImage || null;
    if (!playlistCoverImage && successfulDownloads > 0) {
      let firstTrackId = null;
      for (let index = 0; index < videos.length; index++) {
        const video = videos[index];
        const result = results[index];
        const position = video.playlist_index
          ? video.playlist_index - 1
          : index;

        if (position === 0 && result.success && "id" in result && result.id) {
          firstTrackId = result.id;
          break;
        }
      }

      if (firstTrackId) {
        try {
          const audioFile = await AudioRepository.findById(firstTrackId);
          if (audioFile) {
            const tempAudioPath = join(TEMP_DIR, audioFile.filename);
            if (!existsSync(tempAudioPath)) {
              const data = await Storage.download(audioFile.filename);
              await Bun.write(tempAudioPath, data);
            }
            const coverImageId = crypto.randomUUID();
            const extractedCoverImage = await this.extractAlbumArt(
              tempAudioPath,
              coverImageId,
            );
            if (extractedCoverImage) {
              playlistCoverImage = extractedCoverImage;
              logger.info(
                `Extracted album art from first track's file for playlist cover: ${playlistCoverImage}`,
                { context: "YOUTUBE" },
              );
            }
          }
        } catch (error) {
          logger.error(
            "Failed to extract album art from first track for playlist cover",
            error,
            { context: "YOUTUBE" },
          );
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
      logger.info(`Updated playlist cover image: ${playlistCoverImage}`, {
        context: "YOUTUBE",
      });
    }

    logger.info(
      `Playlist download completed: ${successfulDownloads}/${totalVideos} successful`,
      { context: "YOUTUBE" },
    );

    const playlistResult: AudioModel.youtubePlaylistResponse = {
      success: allSuccessful,
      isPlaylist: true as const,
      playlistId: youtubePlaylistId,
      playlistTitle,
      results,
      totalVideos,
      successfulDownloads,
      failedDownloads,
      message: allSuccessful
        ? `Successfully downloaded all ${successfulDownloads} videos from playlist`
        : `Downloaded ${successfulDownloads} of ${totalVideos} videos. ${failedDownloads} failed.`,
    };

    sendEvent({
      type: "complete",
      message: playlistResult.message,
      result: playlistResult,
    });
  }
}
