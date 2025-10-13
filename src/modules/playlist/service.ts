import { status } from "elysia";
import { existsSync, unlinkSync } from "fs";
import { join, extname } from "path";
import type { PlaylistModel } from "./model";
import { PlaylistRepository, AudioRepository } from "../../db/repository";
import { generateId, UPLOADS_DIR } from "../../utils/helpers";
import { logger } from "../../utils/logger";

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

  static async findOrCreateArtistPlaylist(artistName: string): Promise<string> {
    const playlistId = this.generatePlaylistId("artist", artistName);

    const existing = await PlaylistRepository.findById(playlistId);
    if (existing) {
      return existing.id;
    }

    const playlist = await PlaylistRepository.create({
      id: playlistId,
      name: artistName,
      userId: "admin",
      coverImage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    logger.info(`Created artist playlist: ${playlist.id} (${playlist.name})`, {
      context: "PLAYLIST",
    });

    return playlist.id;
  }

  static async findOrCreateAlbumPlaylist(
    albumName: string,
    artistName?: string
  ): Promise<string> {
    const uniqueName = artistName ? `${albumName}_${artistName}` : albumName;
    const playlistId = this.generatePlaylistId("album", uniqueName);

    const existing = await PlaylistRepository.findById(playlistId);
    if (existing) {
      return existing.id;
    }

    const playlist = await PlaylistRepository.create({
      id: playlistId,
      name: albumName,
      userId: "admin",
      coverImage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    logger.info(`Created album playlist: ${playlist.id} (${playlist.name})`, {
      context: "PLAYLIST",
    });

    return playlist.id;
  }

  static async addTrackToAutoPlaylists(
    audioId: string,
    artist?: string,
    album?: string
  ): Promise<void> {
    const playlistsToAdd: string[] = [];

    if (artist) {
      const artistPlaylistId = await this.findOrCreateArtistPlaylist(artist);
      playlistsToAdd.push(artistPlaylistId);
    }

    if (album) {
      const albumPlaylistId = await this.findOrCreateAlbumPlaylist(
        album,
        artist
      );
      playlistsToAdd.push(albumPlaylistId);
    }

    for (const playlistId of playlistsToAdd) {
      const existingItem = await PlaylistRepository.findItemByAudioAndPlaylist(
        playlistId,
        audioId
      );

      if (!existingItem) {
        const maxPosition = await PlaylistRepository.getMaxPosition(playlistId);
        await PlaylistRepository.addItem({
          id: crypto.randomUUID(),
          playlistId,
          audioId,
          position: maxPosition + 1,
          addedAt: new Date(),
        });

        logger.info(`Added track ${audioId} to playlist ${playlistId}`, {
          context: "PLAYLIST",
        });
      }
    }
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
      const filePath = join(UPLOADS_DIR, coverImageFile);

      try {
        await Bun.write(filePath, coverImage);
      } catch (error) {
        logger.error("Failed to write cover image", error, {
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
    type?: "artist" | "album" | "user" | "auto",
    limit?: number
  ): Promise<PlaylistModel.listResponse> {
    const playlists = await PlaylistRepository.findByUserId(userId, type, limit);

    const filteredPlaylists = playlists.filter((playlist) => {
      if (!type) return true;

      const isArtist = playlist.id.startsWith("artist_");
      const isAlbum = playlist.id.startsWith("album_");
      const isUserCreated = !isArtist && !isAlbum;

      switch (type) {
        case "artist":
          return isArtist;
        case "album":
          return isAlbum;
        case "user":
          return isUserCreated;
        case "auto":
          return isArtist || isAlbum;
        default:
          return true;
      }
    });

    const playlistsWithCount = await Promise.all(
      filteredPlaylists.map(async (playlist) => {
        const items = await PlaylistRepository.getItems(playlist.id);
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

    const itemsData = await PlaylistRepository.getItems(playlistId);

    const items: PlaylistModel.playlistItem[] = itemsData.map((data) => ({
      id: data.item.id,
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
        const oldImagePath = join(UPLOADS_DIR, playlist.coverImage);
        if (existsSync(oldImagePath)) {
          unlinkSync(oldImagePath);
        }
      }

      const id = generateId();
      coverImageFile = `playlist_${id}${ext}`;
      const filePath = join(UPLOADS_DIR, coverImageFile);

      try {
        await Bun.write(filePath, coverImage);
      } catch (error) {
        logger.error("Failed to write cover image", error, {
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

    const items = await PlaylistRepository.getItems(playlistId);

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
      const imagePath = join(UPLOADS_DIR, playlist.coverImage);
      if (existsSync(imagePath)) {
        unlinkSync(imagePath);
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
        id: item.id,
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

  static async getPlaylistImageStream(
    playlistId: string,
    userId: string
  ): Promise<{ playlist: any; imagePath: string }> {
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

    const imagePath = join(UPLOADS_DIR, playlist.coverImage);

    if (!existsSync(imagePath)) {
      throw status(404, "Cover image file not found on disk");
    }

    return { playlist, imagePath };
  }
}
