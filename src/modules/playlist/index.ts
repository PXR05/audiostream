import { Elysia, t } from "elysia";
import { PlaylistService } from "./service";
import { PlaylistModel } from "./model";
import { authPlugin, type AuthData } from "../../utils/auth";

export const playlistController = new Elysia({
  prefix: "/playlist",
  tags: ["playlist"],
})
  .use(authPlugin)

  .model({
    "playlist.create": PlaylistModel.createBody,
    "playlist.update": PlaylistModel.updateBody,
    "playlist.params": PlaylistModel.playlistParams,
    "playlist.addItem": PlaylistModel.addItemBody,
    "playlist.itemParams": PlaylistModel.itemParams,
    "playlist.reorder": PlaylistModel.reorderBody,
    "playlist.list": PlaylistModel.listQuery,
  })

  .post(
    "/",
    async ({ body, store }) => {
      const storeWithAuth = store as typeof store & { auth?: AuthData };
      if (!storeWithAuth.auth) {
        throw new Error("Authentication required");
      }

      const userId = storeWithAuth.auth.userId;

      return await PlaylistService.createPlaylist(
        userId,
        body.name,
        body.coverImage
      );
    },
    {
      isAuth: true,
      body: "playlist.create",
      response: {
        200: PlaylistModel.createResponse,
        400: PlaylistModel.errorResponse,
        413: PlaylistModel.errorResponse,
      },
    }
  )

  .get(
    "/",
    async ({ store, query }) => {
      const storeWithAuth = store as typeof store & { auth?: AuthData };
      if (!storeWithAuth.auth) {
        throw new Error("Authentication required");
      }

      const userId = storeWithAuth.auth.userId;

      return await PlaylistService.getUserPlaylists(userId, query.type, query.limit);
    },
    {
      isAuth: true,
      query: "playlist.list",
      response: {
        200: PlaylistModel.listResponse,
      },
    }
  )

  .guard({
    params: "playlist.params",
  })

  .get(
    "/:id",
    async ({ params: { id }, store }) => {
      const storeWithAuth = store as typeof store & { auth?: AuthData };
      if (!storeWithAuth.auth) {
        throw new Error("Authentication required");
      }

      const userId = storeWithAuth.auth.userId;

      return await PlaylistService.getPlaylistById(id, userId);
    },
    {
      isAuth: true,
      response: {
        200: PlaylistModel.detailResponse,
        403: PlaylistModel.errorResponse,
        404: PlaylistModel.errorResponse,
      },
    }
  )

  .get(
    "/:id/image",
    async ({ params: { id }, set, store }) => {
      const storeWithAuth = store as typeof store & { auth?: AuthData };
      if (!storeWithAuth.auth) {
        throw new Error("Authentication required");
      }

      const userId = storeWithAuth.auth.userId;

      const { playlist, imagePath } =
        await PlaylistService.getPlaylistImageStream(id, userId);

      const ext = imagePath.split(".").pop()?.toLowerCase();
      const mimeType =
        ext === "png"
          ? "image/png"
          : ext === "gif"
            ? "image/gif"
            : ext === "webp"
              ? "image/webp"
              : "image/jpeg";

      set.headers["content-type"] = mimeType;
      set.headers["content-disposition"] =
        `inline; filename="${playlist.coverImage}"`;

      return Bun.file(imagePath);
    },
    {
      isAuth: true,
      response: {
        403: PlaylistModel.errorResponse,
        404: PlaylistModel.errorResponse,
      },
    }
  )

  .patch(
    "/:id",
    async ({ params: { id }, body, store }) => {
      const storeWithAuth = store as typeof store & { auth?: AuthData };
      if (!storeWithAuth.auth) {
        throw new Error("Authentication required");
      }

      const userId = storeWithAuth.auth.userId;

      return await PlaylistService.updatePlaylist(
        id,
        userId,
        body.name,
        body.coverImage
      );
    },
    {
      isAuth: true,
      body: "playlist.update",
      response: {
        200: PlaylistModel.updateResponse,
        400: PlaylistModel.errorResponse,
        403: PlaylistModel.errorResponse,
        404: PlaylistModel.errorResponse,
        413: PlaylistModel.errorResponse,
      },
    }
  )

  .delete(
    "/:id",
    async ({ params: { id }, store }) => {
      const storeWithAuth = store as typeof store & { auth?: AuthData };
      if (!storeWithAuth.auth) {
        throw new Error("Authentication required");
      }

      const userId = storeWithAuth.auth.userId;

      return await PlaylistService.deletePlaylist(id, userId);
    },
    {
      isAuth: true,
      response: {
        200: PlaylistModel.deleteResponse,
        403: PlaylistModel.errorResponse,
        404: PlaylistModel.errorResponse,
      },
    }
  )

  .post(
    "/:id/items",
    async ({ params: { id }, body, store }) => {
      const storeWithAuth = store as typeof store & { auth?: AuthData };
      if (!storeWithAuth.auth) {
        throw new Error("Authentication required");
      }

      const userId = storeWithAuth.auth.userId;

      return await PlaylistService.addItemToPlaylist(id, userId, body.audioId);
    },
    {
      isAuth: true,
      body: "playlist.addItem",
      response: {
        200: PlaylistModel.addItemResponse,
        400: PlaylistModel.errorResponse,
        403: PlaylistModel.errorResponse,
        404: PlaylistModel.errorResponse,
      },
    }
  )

  .guard({
    params: "playlist.itemParams",
  })

  .delete(
    "/:id/items/:itemId",
    async ({ params: { id, itemId }, store }) => {
      const storeWithAuth = store as typeof store & { auth?: AuthData };
      if (!storeWithAuth.auth) {
        throw new Error("Authentication required");
      }

      const userId = storeWithAuth.auth.userId;

      return await PlaylistService.removeItemFromPlaylist(id, itemId, userId);
    },
    {
      isAuth: true,
      response: {
        200: PlaylistModel.removeItemResponse,
        403: PlaylistModel.errorResponse,
        404: PlaylistModel.errorResponse,
      },
    }
  )

  .patch(
    "/:id/items/:itemId/position",
    async ({ params: { id, itemId }, body, store }) => {
      const storeWithAuth = store as typeof store & { auth?: AuthData };
      if (!storeWithAuth.auth) {
        throw new Error("Authentication required");
      }

      const userId = storeWithAuth.auth.userId;

      return await PlaylistService.reorderPlaylistItem(
        id,
        itemId,
        userId,
        body.position
      );
    },
    {
      isAuth: true,
      body: "playlist.reorder",
      response: {
        200: PlaylistModel.removeItemResponse,
        403: PlaylistModel.errorResponse,
        404: PlaylistModel.errorResponse,
      },
    }
  );
