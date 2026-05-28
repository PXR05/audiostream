import { existsSync, unlinkSync } from "fs";
import { join } from "path";
import { stat } from "fs/promises";
import { BaseAudioProvider, type DownloadOptions, type EmitProgress } from "./base";
import { AudioRepository, PlaylistRepository } from "../../../db/repositories";
import { generateId, TEMP_DIR } from "../../../utils/helpers";
import { logger } from "../../../utils/logger";
import { Storage } from "../../../utils/storage";
import { AudioService } from "../service";
import { AudioModel } from "../model";
import { NO_ISRC_SENTINEL, normalizeIsrc } from "../../../utils/isrc";
import {
  parseTidalResourceUrl,
  getDownloadUrl,
  parseManifest,
  downloadDirectToFile,
  downloadDashToFile,
  getTidalTrackInfo,
  getTidalTrackIsrc,
  getTidalCollectionInfo,
  searchTidalTracks,
} from "../../../utils/tidal";

export class TidalProvider extends BaseAudioProvider {
  readonly name = "tidal";

  async search(query: string): Promise<AudioModel.tidalSearchResponse> {
    return await searchTidalTracks(query, 10);
  }

  async download(options: DownloadOptions): Promise<void> {
    const { url, userId, sendEvent, signal, quality } = options;
    const streamQuality = quality ?? "LOSSLESS";

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
        streamQuality,
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
          streamQuality,
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
          { context: "TIDAL_PROVIDER" },
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

  private async downloadTidalTrack(
    trackId: number,
    quality: string,
    userId: string,
    sendEvent: EmitProgress,
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
    const inFlight = BaseAudioProvider.inFlightDownloads.get(inFlightKey);
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

    const id = generateId() + "_" + (trackId || "tidal");
    const trackInfoPromise = getTidalTrackInfo(trackId);
    const trackIsrcPromise = getTidalTrackIsrc(trackId, signal);
    let tempFilePath: string | null = null;

    try {
      const downloadInfo = await getDownloadUrl(trackId, quality, signal);
      if (signal?.aborted) throw new Error("Download was cancelled");
      sendEvent({
        type: "info",
        message: `Selected Tidal stream: ${downloadInfo.bitDepth}-bit / ${downloadInfo.sampleRate} Hz`,
      });
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
      const trackIsrc = await trackIsrcPromise;
      let embeddedCoverPath: string | null = null;
      if (trackInfo?.albumCoverUrl) {
        embeddedCoverPath = await this.downloadCoverForEmbedding(
          trackInfo.albumCoverUrl,
          id,
        );
      }

      if (trackInfo || trackIsrc || embeddedCoverPath) {
        await this.embedMetadataWithFfmpeg(tempFilePath, {
          title: trackInfo?.title,
          artist: trackInfo?.artist,
          album: trackInfo?.album,
          albumArtist: trackInfo?.albumArtist,
          trackNumber: trackInfo?.trackNumber,
          discNumber: trackInfo?.discNumber,
          releaseDate: trackInfo?.releaseDate,
          year: trackInfo?.year,
          genre: trackInfo?.genre,
          composer: trackInfo?.composer,
          copyright: trackInfo?.copyright,
          label: trackInfo?.label,
          upc: trackInfo?.upc,
          explicit: trackInfo?.explicit,
          isrc: trackIsrc ?? trackInfo?.isrc ?? undefined,
          coverImagePath: embeddedCoverPath ?? undefined,
        });
      }

      if (embeddedCoverPath && existsSync(embeddedCoverPath)) {
        unlinkSync(embeddedCoverPath);
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
          album: extractedMetadata.album || trackInfo?.album,
          bitDepth: extractedMetadata.bitDepth ?? downloadInfo.bitDepth,
        };
      } else if (trackInfo) {
        finalMetadata = {
          title: trackInfo.title,
          artist: trackInfo.artist,
          album: trackInfo.album,
          bitDepth: downloadInfo.bitDepth,
        };
      } else {
        finalMetadata = {
          bitDepth: downloadInfo.bitDepth,
        };
      }

      const resolvedIsrc =
        trackIsrc ??
        trackInfo?.isrc ??
        normalizeIsrc(extractedMetadata?.isrc) ??
        NO_ISRC_SENTINEL;

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
      logger.error("Tidal download failed", error, { context: "TIDAL_PROVIDER" });
      rejectInFlight(err);
      throw err;
    } finally {
      BaseAudioProvider.inFlightDownloads.delete(inFlightKey);
      if (tempFilePath && existsSync(tempFilePath)) {
        try {
          unlinkSync(tempFilePath);
        } catch {}
      }
    }
  }

  private async findOrCreateTidalCollectionPlaylist(options: {
    type: "album" | "playlist";
    sourceId: string;
    title: string;
    userId: string;
  }): Promise<string> {
    const { type, sourceId, title, userId } = options;
    const playlistId = `tidal_${type}_${sourceId}_${userId}`;

    const existing = await PlaylistRepository.findById(playlistId, {
      includeDeleted: true,
    });
    if (existing) {
      if (existing.deletedAt) {
        const restored = await PlaylistRepository.restore(playlistId, {
          name: title,
          userId,
          coverImage: existing.coverImage,
        });
        return restored?.id ?? playlistId;
      }
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

  private async resolveTidalCollectionCoverImage(options: {
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
    } catch {}

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
          context: "TIDAL_PROVIDER",
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
}
