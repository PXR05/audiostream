import { status } from "elysia";
import { existsSync, unlinkSync } from "fs";
import { writeFile, stat, rename } from "fs/promises";
import { join, extname } from "path";
import * as mm from "music-metadata";
import sharp from "sharp";
import type { AudioModel } from "./model";
import { AudioRepository, PlaylistRepository } from "../../db/repository";
import {
  generateId,
  UPLOADS_DIR,
  ALLOWED_AUDIO_EXTENSIONS,
  MAX_FILE_SIZE,
  getImageFileName,
  getWebPImageFileName,
} from "../../utils/helpers";
import { logger } from "../../utils/logger";
import { PlaylistService } from "../playlist/service";

async function downloadImage(url: string, filepath: string): Promise<boolean> {
  try {
    const response = await fetch(url);
    if (!response.ok) return false;

    const arrayBuffer = await response.arrayBuffer();
    const webpFilepath = filepath.replace(/\.(jpg|jpeg|png|gif)$/i, ".webp");

    await sharp(Buffer.from(arrayBuffer))
      .webp({ quality: 85 })
      .toFile(webpFilepath);

    return true;
  } catch (error) {
    logger.error("Failed to download image", error, { context: "YOUTUBE" });
    return false;
  }
}

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
      logger.error("Metadata extraction failed", error, { context: "AUDIO" });
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

      const webpImageFileName = getWebPImageFileName(audioId);
      const webpImagePath = join(UPLOADS_DIR, webpImageFileName);

      await sharp(picture.data).webp({ quality: 85 }).toFile(webpImagePath);

      return webpImageFileName;
    } catch (error) {
      logger.error("Album art extraction failed", error, { context: "AUDIO" });
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

    try {
      await Bun.write(filePath, file);
    } catch (error) {
      logger.error("Failed to write file to disk", error, { context: "AUDIO" });
      throw status(500, "Failed to save file");
    }

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

    await PlaylistService.addTrackToAutoPlaylists(
      id,
      extractedMetadata?.artist,
      extractedMetadata?.album
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
  ): Promise<AudioModel.youtubeResponse | AudioModel.youtubePlaylistResponse> {
    try {
      const checkProc = Bun.spawn(["yt-dlp", "--version"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const checkExit = await checkProc.exited;
      if (checkExit !== 0) {
        throw new Error("yt-dlp is not installed or not accessible");
      }
    } catch (error) {
      throw status(
        500,
        "yt-dlp is not installed. Please install it from https://github.com/yt-dlp/yt-dlp"
      );
    }

    const isPlaylist = url.includes("list=") || url.includes("/playlist");

    if (isPlaylist) {
      return await this.downloadYoutubePlaylist(url);
    } else {
      return await this.downloadYoutubeSingle(url);
    }
  }

  private static async downloadYoutubeSingle(
    url: string,
    playlistId?: string
  ): Promise<AudioModel.youtubeResponse> {
    try {
      const videoId = new URL(url).searchParams.get("v");

      if (videoId) {
        const existing = await AudioRepository.findByVideoId(videoId);
        if (existing) {
          logger.info(`Video ${videoId} already exists, skipping download`, {
            context: "YOUTUBE",
          });

          if (playlistId) {
            const existingItem =
              await PlaylistRepository.findItemByAudioAndPlaylist(
                playlistId,
                existing.id
              );

            if (!existingItem) {
              const maxPosition =
                await PlaylistRepository.getMaxPosition(playlistId);
              await PlaylistRepository.addItem({
                id: crypto.randomUUID(),
                playlistId: playlistId,
                audioId: existing.id,
                position: maxPosition + 1,
                addedAt: new Date(),
              });
            }
          }

          return {
            success: true,
            id: existing.id,
            filename: existing.filename,
            title: existing.title || existing.filename,
            imageFile: existing.imageFile || undefined,
            message: "Video already exists in database",
          };
        }
      }

      const id = generateId() + "_" + (videoId || "yt");
      const filename = `${id}.mp3`;
      const filePath = join(UPLOADS_DIR, filename);
      const cookiesPath = join(process.cwd(), "cookies.txt");

      const hasCookies = existsSync(cookiesPath);

      const ytDlpArgs = [
        ...(hasCookies ? ["--cookies", cookiesPath] : []),
        "--user-agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        "-f",
        "bestaudio",
        "-x",
        "--audio-format",
        "mp3",
        "--embed-metadata",
        "--embed-thumbnail",
        "--parse-metadata",
        "%(artist,uploader,channel)s:%(meta_artist)s",
        "--parse-metadata",
        "%(meta_artist)s:%(album_artist)s",
        "--parse-metadata",
        "%(meta_artist)s:%(artist)s",
        "--replace-in-metadata",
        "artist",
        "^([^,&]+).*",
        "\\1",
        "--no-playlist",
        "-o",
        filePath,
        url,
      ];

      logger.info(`Downloading YouTube audio: ${url}`, { context: "YOUTUBE" });

      const proc = Bun.spawn(["yt-dlp", ...ytDlpArgs], {
        stdout: "pipe",
        stderr: "pipe",
      });

      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        logger.error("yt-dlp failed", new Error(stderr), {
          context: "YOUTUBE",
        });

        if (existsSync(filePath)) {
          unlinkSync(filePath);
        }

        if (stderr.includes("Private video")) {
          throw new Error("Video is private or unavailable");
        } else if (stderr.includes("not available")) {
          throw new Error("Video not available in your region or was deleted");
        } else if (stderr.includes("Sign in")) {
          throw new Error(
            "Video requires authentication. Add cookies.txt to project root."
          );
        } else {
          throw new Error(`Download failed: ${stderr.substring(0, 200)}`);
        }
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

      await PlaylistService.addTrackToAutoPlaylists(
        id,
        extractedMetadata?.artist,
        extractedMetadata?.album
      );

      if (playlistId) {
        const existingItem =
          await PlaylistRepository.findItemByAudioAndPlaylist(playlistId, id);

        if (!existingItem) {
          const maxPosition =
            await PlaylistRepository.getMaxPosition(playlistId);
          await PlaylistRepository.addItem({
            id: crypto.randomUUID(),
            playlistId: playlistId,
            audioId: id,
            position: maxPosition + 1,
            addedAt: new Date(),
          });
        }
      }

      logger.info(`YouTube download completed: ${id}`, { context: "YOUTUBE" });

      return {
        success: true,
        id,
        filename,
        title: extractedMetadata?.title || filename,
        imageFile: extractedImage || undefined,
        message: "YouTube audio downloaded successfully",
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error occurred";
      throw status(500, `Failed to download YouTube audio: ${errorMessage}`);
    }
  }

  private static async downloadYoutubePlaylist(
    url: string
  ): Promise<AudioModel.youtubePlaylistResponse> {
    try {
      const cookiesPath = "cookies.txt";
      const hasCookies = existsSync(cookiesPath);

      logger.info(`Fetching YouTube playlist info: ${url}`, {
        context: "YOUTUBE",
      });

      if (hasCookies) {
        logger.info(`Using cookies in ${cookiesPath}`);
      }

      const infoArgs = [
        ...(hasCookies ? ["--cookies", cookiesPath] : []),
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
          `Failed to fetch playlist info: ${stderr.substring(0, 200)}`
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
      const playlistThumbnails = playlistInfo.thumbnails;

      logger.info(
        `Downloading ${videos.length} videos from playlist: ${playlistTitle}`,
        { context: "YOUTUBE" }
      );

      const youtubePlaylistId = `youtube_${playlistId}`;
      const dbPlaylistId = await PlaylistService.findOrCreateYoutubePlaylist(
        playlistId,
        playlistTitle
      );

      const existingPlaylist = await PlaylistRepository.findById(dbPlaylistId);
      let playlistCoverImage: string | null =
        existingPlaylist?.coverImage || null;

      if (
        !playlistCoverImage &&
        playlistThumbnails &&
        playlistThumbnails.length > 0
      ) {
        const bestThumbnail = playlistThumbnails[playlistThumbnails.length - 1];
        if (bestThumbnail.url) {
          const imageExt = ".jpg";
          const imageFileName = `playlist_youtube_${playlistId}${imageExt}`;
          const webpImageFileName = `playlist_youtube_${playlistId}.webp`;
          const imagePath = join(UPLOADS_DIR, imageFileName);

          logger.info(`Downloading playlist thumbnail: ${bestThumbnail.url}`, {
            context: "YOUTUBE",
          });

          const downloaded = await downloadImage(bestThumbnail.url, imagePath);
          if (downloaded) {
            // Check if WebP version was created
            const webpPath = join(UPLOADS_DIR, webpImageFileName);
            if (existsSync(webpPath)) {
              playlistCoverImage = webpImageFileName;
              logger.info(
                `Playlist thumbnail saved as WebP: ${webpImageFileName}`,
                {
                  context: "YOUTUBE",
                }
              );
            } else {
              playlistCoverImage = imageFileName;
              logger.info(`Playlist thumbnail saved: ${imageFileName}`, {
                context: "YOUTUBE",
              });
            }
          }
        }
      }

      const outputTemplate = join(UPLOADS_DIR, "%(id)s.%(ext)s");

      const ytDlpArgs = [
        ...(hasCookies ? ["--cookies", cookiesPath] : []),
        "--user-agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        "-f",
        "bestaudio",
        "-x",
        "--audio-format",
        "mp3",
        "--embed-metadata",
        "--embed-thumbnail",
        "--parse-metadata",
        "%(artist,uploader,channel)s:%(meta_artist)s",
        "--parse-metadata",
        "%(meta_artist)s:%(album_artist)s",
        "--parse-metadata",
        "%(meta_artist)s:%(artist)s",
        "--replace-in-metadata",
        "artist",
        "^([^,&]+).*",
        "\\1",
        "--print-json",
        "-o",
        outputTemplate,
        url,
      ];

      logger.info(`Starting playlist download with yt-dlp`, {
        context: "YOUTUBE",
      });

      const proc = Bun.spawn(["yt-dlp", ...ytDlpArgs], {
        stdout: "pipe",
        stderr: "pipe",
      });

      const exitCode = await proc.exited;
      const stdoutText = await new Response(proc.stdout).text();
      const stderrText = await new Response(proc.stderr).text();

      if (exitCode !== 0) {
        logger.error("yt-dlp playlist download failed", new Error(stderrText), {
          context: "YOUTUBE",
        });
        throw new Error(`Download failed: ${stderrText.substring(0, 200)}`);
      }

      const downloadedFiles: any[] = [];
      const jsonLines = stdoutText
        .trim()
        .split("\n")
        .filter((line) => line.trim());

      for (const line of jsonLines) {
        try {
          const info = JSON.parse(line);
          if (info.filepath || info._filename) {
            downloadedFiles.push(info);
          }
        } catch (e) {}
      }

      logger.info(`Processing ${downloadedFiles.length} downloaded files`, {
        context: "YOUTUBE",
      });

      const results = [];
      for (let index = 0; index < downloadedFiles.length; index++) {
        const fileInfo = downloadedFiles[index];
        const videoId = fileInfo.id || fileInfo.display_id;
        const videoTitle = fileInfo.title || "Unknown";
        const originalFilePath = (
          fileInfo.filepath || fileInfo._filename
        ).replace(".webm", ".mp3");

        try {
          if (videoId) {
            const existing = await AudioRepository.findByVideoId(videoId);
            if (existing) {
              logger.info(
                `Video ${videoId} already exists, skipping (${index + 1}/${downloadedFiles.length})`,
                { context: "YOUTUBE" }
              );

              if (existsSync(originalFilePath)) {
                try {
                  unlinkSync(originalFilePath);
                } catch (e) {}
              }

              const existingItem =
                await PlaylistRepository.findItemByAudioAndPlaylist(
                  dbPlaylistId,
                  existing.id
                );

              if (!existingItem) {
                const maxPosition =
                  await PlaylistRepository.getMaxPosition(dbPlaylistId);
                await PlaylistRepository.addItem({
                  id: crypto.randomUUID(),
                  playlistId: dbPlaylistId,
                  audioId: existing.id,
                  position: maxPosition + 1,
                  addedAt: new Date(),
                });
              }

              results.push({
                success: true,
                id: existing.id,
                filename: existing.filename,
                title: existing.title || videoTitle,
                imageFile: existing.imageFile || undefined,
                message: "Already exists in database",
              });

              continue;
            }
          }

          if (!existsSync(originalFilePath)) {
            throw new Error(`Downloaded file not found: ${originalFilePath}`);
          }

          const id = generateId() + "_" + videoId;
          const filename = `${id}.mp3`;
          const newFilePath = join(UPLOADS_DIR, filename);

          await rename(originalFilePath, newFilePath);

          const stats = await stat(newFilePath);

          const extractedMetadata = await this.extractMetadata(newFilePath);
          const extractedImage = await this.extractAlbumArt(newFilePath, id);

          await AudioRepository.create(
            AudioRepository.fromMetadata(
              id,
              filename,
              stats.size,
              extractedMetadata ?? undefined,
              extractedImage ?? undefined
            )
          );

          await PlaylistService.addTrackToAutoPlaylists(
            id,
            extractedMetadata?.artist,
            extractedMetadata?.album
          );

          const existingItem =
            await PlaylistRepository.findItemByAudioAndPlaylist(
              dbPlaylistId,
              id
            );

          if (!existingItem) {
            const maxPosition =
              await PlaylistRepository.getMaxPosition(dbPlaylistId);
            await PlaylistRepository.addItem({
              id: crypto.randomUUID(),
              playlistId: dbPlaylistId,
              audioId: id,
              position: maxPosition + 1,
              addedAt: new Date(),
            });
          }

          logger.info(
            `Processed video ${index + 1}/${downloadedFiles.length}: ${videoTitle}`,
            { context: "YOUTUBE" }
          );

          results.push({
            success: true,
            id,
            filename,
            title: extractedMetadata?.title || videoTitle,
            imageFile: extractedImage || undefined,
            message: "Downloaded successfully",
          });
        } catch (error: any) {
          const errorMessage = error.message || "Unknown error occurred";
          logger.error(`Failed to process video: ${videoTitle}`, error, {
            context: "YOUTUBE",
          });

          if (originalFilePath && existsSync(originalFilePath)) {
            try {
              unlinkSync(originalFilePath);
            } catch (e) {}
          }

          results.push({
            success: false as const,
            title: videoTitle,
            error: errorMessage,
          });
        }
      }

      const successfulDownloads = results.filter((r) => r.success).length;
      const failedDownloads = results.filter((r) => !r.success).length;
      const totalVideos = videos.length;
      const allSuccessful = failedDownloads === 0;

      if (!playlistCoverImage && successfulDownloads > 0) {
        const firstSuccessfulTrack = results.find(
          (r) => r.success && "imageFile" in r
        );
        if (
          firstSuccessfulTrack &&
          "imageFile" in firstSuccessfulTrack &&
          firstSuccessfulTrack.imageFile
        ) {
          playlistCoverImage = firstSuccessfulTrack.imageFile;
          logger.info(
            `Using first track's image as playlist cover: ${playlistCoverImage}`,
            { context: "YOUTUBE" }
          );
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
        { context: "YOUTUBE" }
      );

      return {
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
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error occurred";
      throw status(500, `Failed to download YouTube playlist: ${errorMessage}`);
    }
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

    const baseImageName = file.imageFile.substring(
      0,
      file.imageFile.lastIndexOf(".")
    );
    const webpImageName = `${baseImageName}.webp`;
    const webpImagePath = join(UPLOADS_DIR, webpImageName);

    if (existsSync(webpImagePath)) {
      return {
        file: { ...file, imageFile: webpImageName },
        imagePath: webpImagePath,
      };
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

  static async getRandomAudioFiles(options?: {
    page?: number;
    limit?: number;
    seed?: string;
    firstTrackId?: string;
  }): Promise<AudioModel.audioListResponse> {
    const {
      page = 1,
      limit = 20,
      seed = "default-seed",
      firstTrackId,
    } = options || {};

    const { files: allDbFiles } = await AudioRepository.findAll({
      page: 1,
      limit: 999999,
      sortBy: "id",
      sortOrder: "asc",
    });

    let shuffledFiles = shuffleWithSeed(allDbFiles, seed);

    if (firstTrackId) {
      const firstTrackIndex = shuffledFiles.findIndex(
        (file) => file.id === firstTrackId
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
      AudioRepository.toAudioModel(dbFile)
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
}
