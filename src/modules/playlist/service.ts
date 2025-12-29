import { status } from "elysia";
import { extname } from "path";
import type { PlaylistModel } from "./model";
import { PlaylistRepository, AudioRepository } from "../../db/repositories";
import { generateId } from "../../utils/helpers";
import { logger } from "../../utils/logger";
import { Storage } from "../../utils/storage";

const ALLOWED_IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

export abstract class PlaylistService {
  static generatePlaylistId(prefix: string, name: string): string {
    const normalized = name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 50);

    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(name);
    const hash = hasher.digest("hex").slice(0, 8);

    if (normalized.length > 0) {
      return `${prefix}_${normalized}_${hash}`;
    } else {
      return `${prefix}_${hash}`;
    }
  }

  static async findOrCreateYoutubePlaylist(
    youtubePlaylistId: string,
    playlistTitle: string,
    userId: string
  ): Promise<string> {
    const playlistId = `youtube_${youtubePlaylistId}`;

    const existing = await PlaylistRepository.findById(playlistId);
    if (existing) {
      if (existing.userId !== userId) {
        throw status(403, "You don't have access to this playlist");
      }
      return existing.id;
    }

    const playlist = await PlaylistRepository.create({
      id: playlistId,
      name: playlistTitle,
      userId: userId,
      coverImage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    logger.info(`Created YouTube playlist: ${playlist.id} (${playlist.name})`, {
      context: "PLAYLIST",
    });

    return playlist.id;
  }

  static async createPlaylist(
    userId: string,
    name: string,
    coverImage?: File
  ): Promise<PlaylistModel.createResponse> {
    let coverImageFile: string | undefined;

    if (coverImage) {
      if (coverImage.size > MAX_IMAGE_SIZE) {
        throw status(
          413,
          `Image too large. Maximum size: ${MAX_IMAGE_SIZE / (1024 * 1024)}MB`
        );
      }

      const ext = extname(coverImage.name).toLowerCase();
      if (!ALLOWED_IMAGE_EXTENSIONS.includes(ext)) {
        throw status(
          400,
          `Invalid image format. Allowed: ${ALLOWED_IMAGE_EXTENSIONS.join(", ")}`
        );
      }

      const id = generateId();
      coverImageFile = `playlist_${id}${ext}`;

      try {
        const data = await coverImage.arrayBuffer();
        const contentType = this.getImageContentType(ext);
        await Storage.upload(coverImageFile, new Uint8Array(data), contentType);
      } catch (error) {
        logger.error("Failed to upload cover image", error, {
          context: "PLAYLIST",
        });
        throw status(500, "Failed to save cover image");
      }
    }

    const playlistId = crypto.randomUUID();
    const playlist = await PlaylistRepository.create({
      id: playlistId,
      name,
      userId,
      coverImage: coverImageFile || null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    logger.info(`Playlist created: ${playlist.id} (${playlist.name})`, {
      context: "PLAYLIST",
    });

    return {
      success: true,
      playlist: {
        id: playlist.id,
        name: playlist.name,
        userId: playlist.userId,
        coverImage: playlist.coverImage ?? undefined,
        createdAt: playlist.createdAt,
        updatedAt: playlist.updatedAt,
        itemCount: 0,
      },
      message: "Playlist created successfully",
    };
  }

  static async getUserPlaylists(
    userId: string,
    type?: "artist" | "album" | "user" | "auto" | "youtube",
    limit?: number
  ): Promise<PlaylistModel.listResponse> {
    const playlists = await PlaylistRepository.findByUserId(
      userId,
      type,
      limit
    );

    const playlistsWithCount = await Promise.all(
      playlists.map(async (playlist) => {
        const items = await PlaylistRepository.getItems(playlist.id, userId);
        return {
          id: playlist.id,
          name: playlist.name,
          userId: playlist.userId,
          coverImage: playlist.coverImage ?? undefined,
          createdAt: playlist.createdAt,
          updatedAt: playlist.updatedAt,
          itemCount: items.length,
        };
      })
    );

    return { playlists: playlistsWithCount };
  }

  static async getPlaylistById(
    playlistId: string,
    userId: string
  ): Promise<PlaylistModel.detailResponse> {
    const playlist = await PlaylistRepository.findById(playlistId);

    if (!playlist) {
      throw status(404, "Playlist not found");
    }

    if (playlist.userId !== userId) {
      throw status(403, "You don't have access to this playlist");
    }

    const itemsData = await PlaylistRepository.getItems(playlistId, userId);

    const items: PlaylistModel.playlistItem[] = itemsData.map((data) => ({
      id: data.item.id!,
      position: data.item.position,
      addedAt: data.item.addedAt,
      audio: AudioRepository.toAudioModel(data.audio),
    }));

    return {
      playlist: {
        id: playlist.id,
        name: playlist.name,
        userId: playlist.userId,
        coverImage: playlist.coverImage ?? undefined,
        createdAt: playlist.createdAt,
        updatedAt: playlist.updatedAt,
        items,
      },
    };
  }

  static async updatePlaylist(
    playlistId: string,
    userId: string,
    name?: string,
    coverImage?: File
  ): Promise<PlaylistModel.updateResponse> {
    const playlist = await PlaylistRepository.findById(playlistId);

    if (!playlist) {
      throw status(404, "Playlist not found");
    }

    if (playlist.userId !== userId) {
      throw status(403, "You don't have access to this playlist");
    }

    let coverImageFile = playlist.coverImage;

    if (coverImage) {
      if (coverImage.size > MAX_IMAGE_SIZE) {
        throw status(
          413,
          `Image too large. Maximum size: ${MAX_IMAGE_SIZE / (1024 * 1024)}MB`
        );
      }

      const ext = extname(coverImage.name).toLowerCase();
      if (!ALLOWED_IMAGE_EXTENSIONS.includes(ext)) {
        throw status(
          400,
          `Invalid image format. Allowed: ${ALLOWED_IMAGE_EXTENSIONS.join(", ")}`
        );
      }

      if (playlist.coverImage) {
        try {
          await Storage.delete(playlist.coverImage);
        } catch {
          // Ignore if old image doesn't exist
        }
      }

      coverImageFile = `playlist_${playlistId}${ext}`;

      try {
        const data = await coverImage.arrayBuffer();
        const contentType = this.getImageContentType(ext);
        await Storage.upload(coverImageFile, new Uint8Array(data), contentType);
      } catch (error) {
        logger.error("Failed to upload cover image", error, {
          context: "PLAYLIST",
        });
        throw status(500, "Failed to save cover image");
      }
    }

    const updated = await PlaylistRepository.update(playlistId, {
      name: name ?? playlist.name,
      coverImage: coverImageFile,
    });

    if (!updated) {
      throw status(500, "Failed to update playlist");
    }

    const items = await PlaylistRepository.getItems(playlistId, userId);

    return {
      success: true,
      playlist: {
        id: updated.id,
        name: updated.name,
        userId: updated.userId,
        coverImage: updated.coverImage ?? undefined,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
        itemCount: items.length,
      },
      message: "Playlist updated successfully",
    };
  }

  static async deletePlaylist(
    playlistId: string,
    userId: string
  ): Promise<PlaylistModel.deleteResponse> {
    const playlist = await PlaylistRepository.findById(playlistId);

    if (!playlist) {
      throw status(404, "Playlist not found");
    }

    if (playlist.userId !== userId) {
      throw status(403, "You don't have access to this playlist");
    }

    if (playlist.coverImage) {
      try {
        await Storage.delete(playlist.coverImage);
      } catch {
        // Ignore if image doesn't exist
      }
    }

    await PlaylistRepository.delete(playlistId);

    logger.info(`Playlist deleted: ${playlistId}`, { context: "PLAYLIST" });

    return { success: true, message: "Playlist deleted successfully" };
  }

  static async addItemToPlaylist(
    playlistId: string,
    userId: string,
    audioId: string
  ): Promise<PlaylistModel.addItemResponse> {
    const playlist = await PlaylistRepository.findById(playlistId);

    if (!playlist) {
      throw status(404, "Playlist not found");
    }

    if (playlist.userId !== userId) {
      throw status(403, "You don't have access to this playlist");
    }

    const audio = await AudioRepository.findById(audioId);
    if (!audio) {
      throw status(404, "Audio file not found");
    }

    const existingItem = await PlaylistRepository.findItemByAudioAndPlaylist(
      playlistId,
      audioId
    );

    if (existingItem) {
      throw status(400, "This audio is already in the playlist");
    }

    const maxPosition = await PlaylistRepository.getMaxPosition(playlistId);
    const newPosition = maxPosition + 1;

    const item = await PlaylistRepository.addItem({
      id: crypto.randomUUID(),
      playlistId,
      audioId,
      position: newPosition,
      addedAt: new Date(),
    });

    return {
      success: true,
      item: {
        id: item.id!,
        position: item.position,
        addedAt: item.addedAt,
        audio: AudioRepository.toAudioModel(audio),
      },
      message: "Item added to playlist",
    };
  }

  static async removeItemFromPlaylist(
    playlistId: string,
    itemId: string,
    userId: string
  ): Promise<PlaylistModel.removeItemResponse> {
    const playlist = await PlaylistRepository.findById(playlistId);

    if (!playlist) {
      throw status(404, "Playlist not found");
    }

    if (playlist.userId !== userId) {
      throw status(403, "You don't have access to this playlist");
    }

    const removed = await PlaylistRepository.removeItem(itemId);

    if (!removed) {
      throw status(404, "Item not found in playlist");
    }

    return { success: true, message: "Item removed from playlist" };
  }

  static async reorderPlaylistItem(
    playlistId: string,
    itemId: string,
    userId: string,
    newPosition: number
  ): Promise<PlaylistModel.removeItemResponse> {
    const playlist = await PlaylistRepository.findById(playlistId);

    if (!playlist) {
      throw status(404, "Playlist not found");
    }

    if (playlist.userId !== userId) {
      throw status(403, "You don't have access to this playlist");
    }

    await PlaylistRepository.reorderItems(playlistId, itemId, newPosition);

    return { success: true, message: "Item reordered successfully" };
  }

  static async getPlaylistImageData(
    playlistId: string,
    userId: string
  ): Promise<{ playlist: any; data: Buffer; contentType: string }> {
    const playlist = await PlaylistRepository.findById(playlistId);

    if (!playlist) {
      throw status(404, "Playlist not found");
    }

    if (playlist.userId !== userId) {
      throw status(403, "You don't have access to this playlist");
    }

    if (!playlist.coverImage) {
      throw status(404, "No cover image found for this playlist");
    }

    const exists = await Storage.exists(playlist.coverImage);
    if (!exists) {
      throw status(404, "Cover image not found in storage");
    }

    const data = await Storage.download(playlist.coverImage);
    const ext = extname(playlist.coverImage).toLowerCase();
    const contentType = this.getImageContentType(ext);

    return { playlist, data, contentType };
  }

  private static getImageContentType(ext: string): string {
    const types: Record<string, string> = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
    };
    return types[ext] || "image/jpeg";
  }
}
