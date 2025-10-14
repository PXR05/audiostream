import { t } from "elysia";

export namespace PlaylistModel {
  export const createBody = t.Object({
    name: t.String({ minLength: 1, maxLength: 255 }),
    coverImage: t.Optional(t.File()),
  });
  export type createBody = typeof createBody.static;

  export const updateBody = t.Object({
    name: t.Optional(t.String({ minLength: 1, maxLength: 255 })),
    coverImage: t.Optional(t.File()),
  });
  export type updateBody = typeof updateBody.static;

  export const playlistParams = t.Object({
    id: t.String(),
  });
  export type playlistParams = typeof playlistParams.static;

  export const addItemBody = t.Object({
    audioId: t.String(),
  });
  export type addItemBody = typeof addItemBody.static;

  export const itemParams = t.Object({
    id: t.String(),
    itemId: t.String(),
  });
  export type itemParams = typeof itemParams.static;

  export const reorderBody = t.Object({
    position: t.Number({ minimum: 0 }),
  });
  export type reorderBody = typeof reorderBody.static;

  export const listQuery = t.Object({
    type: t.Optional(
      t.Union([
        t.Literal("artist"),
        t.Literal("album"),
        t.Literal("user"),
        t.Literal("auto"),
        t.Literal("youtube"),
      ])
    ),
    limit: t.Optional(t.Number({ minimum: 1 })),
  });
  export type listQuery = typeof listQuery.static;

  export const playlistItem = t.Object({
    id: t.String(),
    position: t.Number(),
    addedAt: t.Date(),
    audio: t.Object({
      id: t.String(),
      filename: t.String(),
      size: t.Number(),
      uploadedAt: t.Date(),
      imageFile: t.Optional(t.String()),
      metadata: t.Optional(
        t.Object({
          title: t.Optional(t.String()),
          artist: t.Optional(t.String()),
          album: t.Optional(t.String()),
          year: t.Optional(t.Number()),
          genre: t.Optional(t.Array(t.String())),
          duration: t.Optional(t.Number()),
          bitrate: t.Optional(t.Number()),
          sampleRate: t.Optional(t.Number()),
          channels: t.Optional(t.Number()),
          format: t.Optional(t.String()),
        })
      ),
    }),
  });
  export type playlistItem = typeof playlistItem.static;

  export const playlist = t.Object({
    id: t.String(),
    name: t.String(),
    userId: t.String(),
    coverImage: t.Optional(t.String()),
    createdAt: t.Date(),
    updatedAt: t.Date(),
    itemCount: t.Optional(t.Number()),
  });
  export type playlist = typeof playlist.static;

  export const playlistDetail = t.Object({
    id: t.String(),
    name: t.String(),
    userId: t.String(),
    coverImage: t.Optional(t.String()),
    createdAt: t.Date(),
    updatedAt: t.Date(),
    items: t.Array(playlistItem),
  });
  export type playlistDetail = typeof playlistDetail.static;

  export const createResponse = t.Object({
    success: t.Boolean(),
    playlist: playlist,
    message: t.String(),
  });
  export type createResponse = typeof createResponse.static;

  export const updateResponse = t.Object({
    success: t.Boolean(),
    playlist: playlist,
    message: t.String(),
  });
  export type updateResponse = typeof updateResponse.static;

  export const deleteResponse = t.Object({
    success: t.Boolean(),
    message: t.String(),
  });
  export type deleteResponse = typeof deleteResponse.static;

  export const listResponse = t.Object({
    playlists: t.Array(playlist),
  });
  export type listResponse = typeof listResponse.static;

  export const detailResponse = t.Object({
    playlist: playlistDetail,
  });
  export type detailResponse = typeof detailResponse.static;

  export const addItemResponse = t.Object({
    success: t.Boolean(),
    item: playlistItem,
    message: t.String(),
  });
  export type addItemResponse = typeof addItemResponse.static;

  export const removeItemResponse = t.Object({
    success: t.Boolean(),
    message: t.String(),
  });
  export type removeItemResponse = typeof removeItemResponse.static;

  export const errorResponse = t.Object({
    error: t.String(),
    message: t.Optional(t.String()),
  });
  export type errorResponse = typeof errorResponse.static;
}
