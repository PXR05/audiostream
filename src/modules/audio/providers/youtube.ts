import { existsSync, unlinkSync } from "fs";
import { join } from "path";
import { stat } from "fs/promises";
import YTMusic from "ytmusic-api";
import { BaseAudioProvider, type DownloadOptions, type EmitProgress } from "./base";
import { AudioRepository, PlaylistRepository } from "../../../db/repositories";
import { generateId, TEMP_DIR } from "../../../utils/helpers";
import { logger } from "../../../utils/logger";
import { Storage } from "../../../utils/storage";
import { PlaylistService } from "../../playlist/service";
import { AudioService } from "../service";
import { AudioModel } from "../model";
import { NO_ISRC_SENTINEL, normalizeIsrc } from "../../../utils/isrc";
import { getIsrcFromDeezerSearch } from "../../../utils/deezer";
import { getIsrcFromMusicBrainzSearch } from "../../../utils/musicbrainz";

export class YoutubeProvider extends BaseAudioProvider {
  readonly name = "youtube";

  async search(query: string): Promise<AudioModel.youtubeSearchResponse> {
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (apiKey) {
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
    } else {
      const ytmusic = new YTMusic();
      await ytmusic.initialize();
      const searchResults = await ytmusic.searchSongs(query);
      return searchResults.map((result: any) => ({
        videoId: result.videoId,
        title: result.title,
        artist: result.artists?.[0]?.name || "Unknown Artist",
        thumbnail: result.thumbnails?.[0]?.url || "",
      }));
    }
  }

  async download(options: DownloadOptions): Promise<void> {
    const { url, userId, sendEvent, signal } = options;
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
      logger.error("YouTube download failed", error, { context: "YOUTUBE_PROVIDER" });
      throw new Error(
        error instanceof Error ? error.message : "Unknown error occurred",
      );
    }
  }

  private ytDlpBaseArgs(cookies: boolean): string[] {
    const potUrl = process.env.YOUTUBE_POT_URL;

    return [
      ...(cookies ? ["--cookies", "cookies.txt"] : []),
      // "--extractor-args",
      // "youtube:player_client=android,ios",

      // POT: Uncomment the lines below and comment out "youtube:player_client=android,ios" above
      // if you run the BgUtils POT provider container and want full web/mweb format access:
      ...(potUrl ? ["--extractor-args", `youtubepot-bgutilhttp:base_url=${potUrl}`] : []),
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

  private parseYtDlpProgress(
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

  private async resolveYoutubeIsrc(
    metadata: AudioModel.audioMetadata | null,
    signal?: AbortSignal,
  ): Promise<string> {
    const metadataIsrc = normalizeIsrc(metadata?.isrc);
    if (metadataIsrc) {
      return metadataIsrc;
    }

    const deezerIsrc = await getIsrcFromDeezerSearch({
      title: metadata?.title,
      artist: metadata?.artist,
      signal,
    });
    if (deezerIsrc) {
      return deezerIsrc;
    }

    const musicbrainzIsrc = await getIsrcFromMusicBrainzSearch({
      title: metadata?.title,
      artist: metadata?.artist,
      signal,
    });
    if (musicbrainzIsrc) {
      return musicbrainzIsrc;
    }

    return NO_ISRC_SENTINEL;
  }

  private async downloadYoutubeSingle(
    url: string,
    userId: string,
    sendEvent: EmitProgress,
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

      const inFlight = BaseAudioProvider.inFlightDownloads.get(videoId);
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
          context: "YOUTUBE_PROVIDER",
        });
        throw new Error(`Download failed: ${stderr.substring(0, 200)}`);
      }

      sendEvent({ type: "info", message: "Processing file..." });
      const stats = await stat(tempFilePath);
      const [extractedMetadata, extractedImage] = await Promise.all([
        AudioService.extractMetadata(tempFilePath),
        AudioService.extractAlbumArt(tempFilePath, id),
      ]);
      const resolvedIsrc = await this.resolveYoutubeIsrc(
        extractedMetadata,
        signal,
      );

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
          undefined,
          resolvedIsrc,
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
      if (videoId) BaseAudioProvider.inFlightDownloads.delete(videoId);
    }
  }

  private async downloadYoutubePlaylist(
    url: string,
    userId: string,
    sendEvent: EmitProgress,
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
        context: "YOUTUBE_PROVIDER",
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
            context: "YOUTUBE_PROVIDER",
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
      { context: "YOUTUBE_PROVIDER" },
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
          context: "YOUTUBE_PROVIDER",
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
              { context: "YOUTUBE_PROVIDER" },
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
      { context: "YOUTUBE_PROVIDER" },
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
}
