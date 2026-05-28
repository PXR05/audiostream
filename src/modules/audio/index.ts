import { Elysia, t } from "elysia";
import { AudioService } from "./service";
import { AudioModel } from "./model";
import { authPlugin } from "../../utils/auth";
import { Storage } from "../../utils/storage";
import { ProviderRegistry } from "./providers";
import { handleProviderDownload, handleCancelDownload } from "./handlers";

export const audioController = new Elysia({ prefix: "/audio", tags: ["audio"] })
  .use(authPlugin)
  .model({
    "audio.upload": AudioModel.uploadBody,
    "audio.params": AudioModel.audioParams,
    "audio.pagination": AudioModel.paginationQuery,
    "audio.search": AudioModel.searchQuery,
    "audio.searchSuggestions": AudioModel.searchSuggestionsQuery,
    "audio.random": AudioModel.randomQuery,
  })

  .get(
    "/",
    async ({ query, auth }) => {
      return await AudioService.getAudioFiles({
        page: query.page,
        limit: query.limit,
        sortBy: query.sortBy,
        sortOrder: query.sortOrder,
        lastFetchedAt: query.lastFetchedAt,
        artist: query.artist,
        album: query.album,
        genre: query.genre,
        userId: auth.userId,
      });
    },
    {
      isAuth: true,
      query: "audio.pagination",
      response: {
        200: AudioModel.audioListResponse,
      },
    },
  )

  .get(
    "/search",
    async ({ query, auth }) => {
      return await AudioService.search(query.q, {
        page: query.page,
        limit: query.limit,
        userId: auth.userId,
      });
    },
    {
      isAuth: true,
      query: "audio.search",
      response: {
        200: AudioModel.audioListResponse,
      },
    },
  )

  .get(
    "/search/suggestions",
    async ({ query }) => {
      return await AudioService.searchSuggestions(query.q, query.limit);
    },
    {
      isAuth: true,
      query: "audio.searchSuggestions",
      response: {
        200: AudioModel.searchSuggestionsResponse,
      },
    },
  )

  .get(
    "/random",
    async ({ query, auth }) => {
      return await AudioService.getRandomAudioFiles({
        page: query.page,
        limit: query.limit,
        seed: query.seed,
        firstTrackId: query.firstTrackId,
        userId: auth.userId,
      });
    },
    {
      isAuth: true,
      query: "audio.random",
      response: {
        200: AudioModel.audioListResponse,
      },
    },
  )

  .post(
    "/upload",
    async ({ body, auth }) => {
      if (body.file) {
        return await AudioService.uploadFile(body.file, auth.userId);
      } else if (body.files) {
        if (Array.isArray(body.files)) {
          if (body.files.length === 0) {
            throw new Error("No files provided");
          }
          return await AudioService.uploadFiles(body.files, auth.userId);
        } else {
          return await AudioService.uploadFile(body.files as File, auth.userId);
        }
      } else {
        throw new Error("No file or files provided");
      }
    },
    {
      body: "audio.upload",
      isAdmin: true,
      response: {
        200: t.Union([
          AudioModel.uploadResponse,
          AudioModel.multiUploadResponse,
        ]),
        400: AudioModel.errorResponse,
        413: AudioModel.errorResponse,
      },
    },
  )

  .state(
    "activeDownloads",
    new Map<
      string,
      {
        listeners: Set<(data: AudioModel.youtubeProgressEvent) => void>;
        promise: Promise<void> | null;
        abortController: AbortController;
        userId: string;
      }
    >(),
  )

  .get(
    "/search/:provider",
    async ({ params: { provider }, query, set }) => {
      const p = ProviderRegistry.get(provider);
      if (!p) {
        set.status = 404;
        return { error: `Provider ${provider} not found` };
      }
      return await p.search(query.q);
    },
    {
      isAuth: true,
      query: t.Object({
        q: t.String({ minLength: 1 }),
      }),
    },
  )

  .get(
    "/upload/:provider",
    async ({ params: { provider }, query, auth, set, store }) => {
      return handleProviderDownload({ providerName: provider, query, auth, set, store });
    },
    {
      isAuth: true,
      query: t.Object({
        url: t.String({ format: "uri" }),
        stream: t.String({ format: "uuid" }),
        quality: t.Optional(t.String()),
      }),
    },
  )

  .delete(
    "/upload/:provider/:stream",
    async ({ params: { provider, stream }, store, auth }) => {
      return handleCancelDownload({ providerName: provider, stream, store, auth });
    },
    {
      isAuth: true,
      params: t.Object({
        provider: t.String(),
        stream: t.String(),
      }),
      response: {
        200: t.Object({
          success: t.Boolean(),
          message: t.String(),
        }),
      },
    },
  )

  .guard({
    params: "audio.params",
  })

  .get(
    "/:id",
    async ({ params: { id }, auth }) => {
      const file = await AudioService.getAudioById(id, auth.userId);
      return { file };
    },
    {
      isAuth: true,
      response: {
        200: AudioModel.audioDetailResponse,
        404: AudioModel.errorResponse,
      },
    },
  )

  .delete(
    "/:id",
    async ({ params: { id }, auth }) => {
      return await AudioService.deleteAudio(id, auth.userId);
    },
    {
      isAuth: true,
      response: {
        200: AudioModel.deleteResponse,
        403: AudioModel.errorResponse,
        404: AudioModel.errorResponse,
        500: AudioModel.errorResponse,
      },
    },
  )

  .get(
    "/:id/stream",
    async ({ params: { id }, set, request, auth }) => {
      const { file, size, contentType } = await AudioService.getAudioStreamInfo(
        id,
        auth.userId,
      );

      const filename = file.metadata?.title
        ? `${file.metadata.artist || "Unknown"} - ${
            file.metadata.title
          }.${file.filename.split(".").pop()}`
        : file.filename;
      const encodedFilename = encodeURIComponent(filename);
      const range = request.headers.get("range");

      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : size - 1;
        const chunkSize = end - start + 1;

        const { stream } = await Storage.getStream(file.filename, {
          start,
          end,
        });

        set.status = 206;
        set.headers["content-range"] = `bytes ${start}-${end}/${size}`;
        set.headers["content-length"] = chunkSize.toString();
        set.headers["content-type"] = contentType;
        set.headers["accept-ranges"] = "bytes";
        set.headers["content-disposition"] =
          `inline; filename="${file.filename}"; filename*=UTF-8''${encodedFilename}`;

        return new Response(stream as unknown as ReadableStream);
      }

      const { stream } = await Storage.getStream(file.filename);

      set.headers["content-type"] = contentType;
      set.headers["content-length"] = size.toString();
      set.headers["accept-ranges"] = "bytes";
      set.headers["content-disposition"] =
        `inline; filename="${file.filename}"; filename*=UTF-8''${encodedFilename}`;

      return new Response(stream as unknown as ReadableStream);
    },
    {
      isAuth: true,
      response: {
        404: AudioModel.errorResponse,
      },
    },
  )

  .get(
    "/:id/image",
    async ({ params: { id }, set, auth }) => {
      const { file, data, contentType } = await AudioService.getImageData(
        id,
        auth.userId,
      );

      const filename = file.metadata?.title
        ? `${file.metadata.artist || "Unknown"} - ${file.metadata.title}.${file.imageFile?.split(".").pop() || "jpg"}`
        : file.imageFile || "cover.jpg";
      const encodedFilename = encodeURIComponent(filename);

      set.headers["cache-control"] = "public, max-age=31536000, immutable";
      set.headers["content-type"] = contentType;
      set.headers["content-disposition"] =
        `inline; filename="${file.imageFile}"; filename*=UTF-8''${encodedFilename}`;

      return new Response(new Uint8Array(data));
    },
    {
      isAuth: true,
      response: {
        404: AudioModel.errorResponse,
      },
    },
  );
