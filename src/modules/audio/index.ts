import { Elysia, t } from "elysia";
import { AudioService } from "./service";
import { AudioModel } from "./model";
import { authPlugin } from "../../utils/auth";
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
    async ({ query, auth }) => {
      return await AudioService.getAudioFiles({
        page: query.page,
        limit: query.limit,
        sortBy: query.sortBy,
        sortOrder: query.sortOrder,
        lastFetchedAt: query.lastFetchedAt,
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
      }
    >(),
  )
  .get(
    "/youtube",
    async ({ query, auth, set, store }) => {
      set.headers["Content-Type"] = "text/event-stream";
      set.headers["Cache-Control"] = "no-cache";
      set.headers["Connection"] = "keep-alive";

      if (store.activeDownloads === undefined)
        store.activeDownloads = new Map();

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

          let downloadInfo = store.activeDownloads.get(query.stream);

          if (!downloadInfo) {
            downloadInfo = {
              listeners: new Set(),
              promise: null,
            };
            store.activeDownloads.set(query.stream, downloadInfo);

            downloadInfo.listeners.add(sendEvent);

            const broadcastEvent = (data: AudioModel.youtubeProgressEvent) => {
              const info = store.activeDownloads.get(query.stream);
              if (info) {
                info.listeners.forEach((listener) => listener(data));
              }
            };

            downloadInfo.promise = AudioService.downloadYoutube(
              query.url,
              auth.userId,
              broadcastEvent,
            )
              .then(() => {
                setTimeout(() => {
                  store.activeDownloads.delete(query.stream);
                }, 1000);
              })
              .catch((error: any) => {
                broadcastEvent({
                  type: "error",
                  message: error.message || "Download failed",
                });
                setTimeout(() => {
                  store.activeDownloads.delete(query.stream);
                }, 1000);
              });
          } else {
            downloadInfo.listeners.add(sendEvent);
          }

          try {
            await downloadInfo.promise;
            if (!isClosed) {
              controller.close();
              isClosed = true;
            }
          } catch (error) {
            if (!isClosed) {
              controller.close();
              isClosed = true;
            }
          } finally {
            const info = store.activeDownloads.get(query.stream);
            if (info) {
              info.listeners.delete(sendEvent);
            }
          }
        },
        cancel() {
          logger.warn(
            "SSE connection closed by client, download will continue in background",
          );
        },
      });

      return new Response(stream);
    },
    {
      isAuth: true,
      query: t.Object({
        url: t.String({ format: "uri" }),
        stream: t.String({ format: "uuid" }),
      }),
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
      const { file, filePath } = await AudioService.getAudioStream(
        id,
        auth.userId,
      );

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
    },
  )

  .get(
    "/:id/image",
    async ({ params: { id }, set, auth }) => {
      const { file, imagePath } = await AudioService.getImageStream(
        id,
        auth.userId,
      );

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
    },
  );
