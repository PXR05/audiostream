import { Elysia } from "elysia";
import { AudioService } from "./service";
import { AudioModel } from "./model";
import { adminAuthGuard } from "../../utils/auth";

export const audioController = new Elysia({ prefix: "/audio" })
  .model({
    "audio.upload": AudioModel.uploadBody,
    "audio.youtube": AudioModel.youtubeBody,
    "audio.params": AudioModel.audioParams,
    "audio.pagination": AudioModel.paginationQuery,
    "audio.search": AudioModel.searchQuery,
    "audio.searchSuggestions": AudioModel.searchSuggestionsQuery,
  })

  .get(
    "/",
    async ({ query }) => {
      return await AudioService.getAudioFiles({
        page: query.page,
        limit: query.limit,
        sortBy: query.sortBy,
        sortOrder: query.sortOrder,
      });
    },
    {
      query: "audio.pagination",
      response: {
        200: AudioModel.audioListResponse,
      },
    }
  )

  .get(
    "/search",
    async ({ query }) => {
      return await AudioService.search(query.q, {
        page: query.page,
        limit: query.limit,
      });
    },
    {
      query: "audio.search",
      response: {
        200: AudioModel.audioListResponse,
      },
    }
  )

  .get(
    "/search/suggestions",
    async ({ query }) => {
      return await AudioService.searchSuggestions(query.q, query.limit);
    },
    {
      query: "audio.searchSuggestions",
      response: {
        200: AudioModel.searchSuggestionsResponse,
      },
    }
  )

  .post(
    "/upload",
    async ({ body }) => {
      return await AudioService.uploadFiles(body.files);
    },
    {
      body: "audio.upload",
      beforeHandle: adminAuthGuard,
      response: {
        200: AudioModel.multiUploadResponse,
        400: AudioModel.errorResponse,
        413: AudioModel.errorResponse,
      },
    }
  )

  .post(
    "/youtube",
    async ({ body }) => {
      return await AudioService.downloadYoutube(body.url);
    },
    {
      body: "audio.youtube",
      beforeHandle: adminAuthGuard,
      response: {
        200: AudioModel.youtubeResponse,
        400: AudioModel.errorResponse,
        500: AudioModel.errorResponse,
      },
    }
  )

  .guard({
    params: "audio.params",
  })

  .get(
    "/:id",
    async ({ params: { id } }) => {
      const file = await AudioService.getAudioById(id);
      return { file };
    },
    {
      response: {
        200: AudioModel.audioDetailResponse,
        404: AudioModel.errorResponse,
      },
    }
  )

  .delete(
    "/:id",
    async ({ params: { id } }) => {
      return await AudioService.deleteAudio(id);
    },
    {
      beforeHandle: adminAuthGuard,
      response: {
        200: AudioModel.deleteResponse,
        403: AudioModel.errorResponse,
        404: AudioModel.errorResponse,
        500: AudioModel.errorResponse,
      },
    }
  )

  .get(
    "/:id/stream",
    async ({ params: { id }, set }) => {
      const { file, filePath } = await AudioService.getAudioStream(id);

      const mimeType =
        file.metadata?.format === "mp3" ? "audio/mpeg" : "audio/*";
      set.headers["content-type"] = mimeType;
      set.headers["accept-ranges"] = "bytes";
      set.headers["content-disposition"] =
        `inline; filename="${file.filename}"`;

      return Bun.file(filePath);
    },
    {
      response: {
        404: AudioModel.errorResponse,
      },
    }
  )

  .get(
    "/:id/image",
    async ({ params: { id }, set }) => {
      const { file, imagePath } = await AudioService.getImageStream(id);

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
        `inline; filename="${file.imageFile}"`;

      return Bun.file(imagePath);
    },
    {
      response: {
        404: AudioModel.errorResponse,
      },
    }
  );
