import { Elysia, t } from "elysia";
import { AudioService } from "./service";
import { AudioModel } from "./model";
import { authPlugin, type AuthData } from "../../utils/auth";
import { logger } from "../../utils/logger";

export const audioController = new Elysia({ prefix: "/audio", tags: ["audio"] })
  .use(authPlugin)

  .model({
    "audio.upload": AudioModel.uploadBody,
    "audio.youtube": AudioModel.youtubeBody,
    "audio.params": AudioModel.audioParams,
    "audio.pagination": AudioModel.paginationQuery,
    "audio.search": AudioModel.searchQuery,
    "audio.searchSuggestions": AudioModel.searchSuggestionsQuery,
    "audio.random": AudioModel.randomQuery,
  })

  .get(
    "/",
    async ({ query, store }) => {
      const storeWithAuth = store as typeof store & { auth?: AuthData };
      if (!storeWithAuth.auth) {
        throw new Error("Authentication required");
      }

      const userId = storeWithAuth.auth.userId;

      return await AudioService.getAudioFiles({
        page: query.page,
        limit: query.limit,
        sortBy: query.sortBy,
        sortOrder: query.sortOrder,
        lastFetchedAt: query.lastFetchedAt,
        userId,
      });
    },
    {
      isAuth: true,
      query: "audio.pagination",
      response: {
        200: AudioModel.audioListResponse,
      },
    }
  )

  .get(
    "/search",
    async ({ query, store }) => {
      const storeWithAuth = store as typeof store & { auth?: AuthData };
      if (!storeWithAuth.auth) {
        throw new Error("Authentication required");
      }

      const userId = storeWithAuth.auth.userId;

      return await AudioService.search(query.q, {
        page: query.page,
        limit: query.limit,
        userId,
      });
    },
    {
      isAuth: true,
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
      isAuth: true,
      query: "audio.searchSuggestions",
      response: {
        200: AudioModel.searchSuggestionsResponse,
      },
    }
  )

  .get(
    "/random",
    async ({ query, store }) => {
      const storeWithAuth = store as typeof store & { auth?: AuthData };
      if (!storeWithAuth.auth) {
        throw new Error("Authentication required");
      }

      const userId = storeWithAuth.auth.userId;

      return await AudioService.getRandomAudioFiles({
        page: query.page,
        limit: query.limit,
        seed: query.seed,
        firstTrackId: query.firstTrackId,
        userId,
      });
    },
    {
      isAuth: true,
      query: "audio.random",
      response: {
        200: AudioModel.audioListResponse,
      },
    }
  )

  .post(
    "/upload",
    async ({ body, store }) => {
      const storeWithAuth = store as typeof store & { auth?: AuthData };
      if (!storeWithAuth.auth) {
        throw new Error("Authentication required");
      }

      const userId = storeWithAuth.auth.userId;

      if (body.file) {
        return await AudioService.uploadFile(body.file, userId);
      } else if (body.files) {
        if (Array.isArray(body.files)) {
          if (body.files.length === 0) {
            throw new Error("No files provided");
          }
          return await AudioService.uploadFiles(body.files, userId);
        } else {
          return await AudioService.uploadFile(body.files as File, userId);
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
    }
  )

  .get(
    "/youtube",
    async ({ query, store, set }) => {
      const storeWithAuth = store as typeof store & { auth?: AuthData };
      if (!storeWithAuth.auth) {
        throw new Error("Authentication required");
      }

      if (!query.url) {
        throw new Error("URL parameter is required");
      }

      const userId = storeWithAuth.auth.userId;

      set.headers["Content-Type"] = "text/event-stream";
      set.headers["Cache-Control"] = "no-cache";
      set.headers["Connection"] = "keep-alive";

      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          let isClosed = false;

          const sendEvent = (data: AudioModel.youtubeProgressEvent) => {
            if (isClosed) return;

            try {
              const message = `data: ${JSON.stringify(data)}\n\n`;
              controller.enqueue(encoder.encode(message));
            } catch (error) {
              isClosed = true;
            }
          };

          try {
            await AudioService.downloadYoutube(query.url, userId, sendEvent);
            if (!isClosed) {
              controller.close();
              isClosed = true;
            }
          } catch (error: any) {
            if (!isClosed) {
              sendEvent({
                type: "error",
                message: error.message || "Download failed",
              });
              controller.close();
              isClosed = true;
            }
          }
        },
        cancel() {
          logger.warn(
            "SSE connection closed by client, download will continue in background"
          );
        },
      });

      return new Response(stream);
    },
    {
      isAuth: true,
      query: t.Object({
        url: t.String({ format: "uri" }),
      }),
    }
  )

  .guard({
    params: "audio.params",
  })

  .get(
    "/:id",
    async ({ params: { id }, store }) => {
      const storeWithAuth = store as typeof store & { auth?: AuthData };
      if (!storeWithAuth.auth) {
        throw new Error("Authentication required");
      }

      const userId = storeWithAuth.auth.userId;

      const file = await AudioService.getAudioById(id, userId);
      return { file };
    },
    {
      isAuth: true,
      response: {
        200: AudioModel.audioDetailResponse,
        404: AudioModel.errorResponse,
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

      return await AudioService.deleteAudio(id, userId);
    },
    {
      isAdmin: true,
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
    async ({ params: { id }, set, request, store }) => {
      const storeWithAuth = store as typeof store & { auth?: AuthData };
      if (!storeWithAuth.auth) {
        throw new Error("Authentication required");
      }

      const userId = storeWithAuth.auth.userId;

      const { file, filePath } = await AudioService.getAudioStream(id, userId);

      const bunFile = Bun.file(filePath);
      const fileSize = bunFile.size;

      const mimeType =
        file.metadata?.format === "mp3" ? "audio/mpeg" : "audio/*";

      const range = request.headers.get("range");

      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;

        set.status = 206;
        set.headers["content-range"] = `bytes ${start}-${end}/${fileSize}`;
        set.headers["content-length"] = chunkSize.toString();
        set.headers["content-type"] = mimeType;
        set.headers["accept-ranges"] = "bytes";
        set.headers["content-disposition"] =
          `inline; filename="${file.filename}"`;

        return bunFile.slice(start, end + 1);
      }

      set.headers["content-type"] = mimeType;
      set.headers["content-length"] = fileSize.toString();
      set.headers["accept-ranges"] = "bytes";
      set.headers["content-disposition"] =
        `inline; filename="${file.filename}"`;

      return bunFile;
    },
    {
      isAuth: true,
      response: {
        404: AudioModel.errorResponse,
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

      const { file, imagePath } = await AudioService.getImageStream(id, userId);

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
      isAuth: true,
      response: {
        404: AudioModel.errorResponse,
      },
    }
  );
