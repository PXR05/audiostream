import { Elysia } from "elysia";
import { AudioService } from "./service";
import { AudioModel } from "./model";

export const audioController = new Elysia({ prefix: "/audio" })
  .model({
    "audio.upload": AudioModel.uploadBody,
    "audio.youtube": AudioModel.youtubeBody,
    "audio.params": AudioModel.audioParams,
    "audio.pagination": AudioModel.paginationQuery,
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

  .post(
    "/upload",
    async ({ body }) => {
      return await AudioService.uploadFile(body.file);
    },
    {
      body: "audio.upload",
      response: {
        200: AudioModel.uploadResponse,
        400: AudioModel.errorResponse,
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
      response: {
        200: AudioModel.deleteResponse,
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
  );
