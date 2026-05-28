import { AudioModel } from "./model";
import { ProviderRegistry } from "./providers";
import { logger } from "../../utils/logger";

export async function handleProviderDownload({
  providerName,
  query,
  auth,
  set,
  store,
}: {
  providerName: string;
  query: { url: string; stream: string; quality?: string };
  auth: { userId: string };
  set: any;
  store: any;
}) {
  set.headers["Content-Type"] = "text/event-stream";
  set.headers["Cache-Control"] = "no-cache";
  set.headers["Connection"] = "keep-alive";

  if (store.activeDownloads === undefined) {
    store.activeDownloads = new Map();
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let isClosed = false;

      function sendEvent(data: AudioModel.youtubeProgressEvent) {
        if (isClosed) return;

        try {
          const message = `data: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(message));
        } catch (error) {
          isClosed = true;
        }
      }

      let downloadInfo = store.activeDownloads.get(query.stream);

      if (!downloadInfo) {
        const provider = ProviderRegistry.get(providerName);
        if (!provider) {
          sendEvent({
            type: "error",
            message: `Provider ${providerName} not found`,
          });
          controller.close();
          return;
        }

        const abortController = new AbortController();
        downloadInfo = {
          listeners: new Set(),
          promise: null,
          abortController,
          userId: auth.userId,
        };
        store.activeDownloads.set(query.stream, downloadInfo);

        downloadInfo.listeners.add(sendEvent);

        function broadcastEvent(data: AudioModel.youtubeProgressEvent) {
          const info = store.activeDownloads.get(query.stream);
          if (info) {
            info.listeners.forEach((listener: (data: AudioModel.youtubeProgressEvent) => void) => listener(data));
          }
          logger.debug(
            `Broadcasting event for stream ${query.stream}: ${data.type} - ${data.message}`,
          );
        }

        downloadInfo.promise = provider
          .download({
            url: query.url,
            userId: auth.userId,
            sendEvent: broadcastEvent,
            signal: abortController.signal,
            quality: query.quality,
          })
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
        `SSE connection closed by client, ${providerName} download will continue in background`,
      );
    },
  });

  return new Response(stream);
}

export async function handleCancelDownload({
  providerName,
  stream,
  store,
  auth,
}: {
  providerName: string;
  stream: string;
  store: any;
  auth: { userId: string };
}) {
  const downloadInfo = store.activeDownloads?.get(stream);
  if (!downloadInfo) {
    return {
      success: false,
      message: "No active download found for this stream",
    };
  }

  if (downloadInfo.userId !== auth.userId) {
    return {
      success: false,
      message: "You can only cancel your own downloads",
    };
  }

  downloadInfo.abortController.abort();
  logger.info(
    `${providerName} download cancelled by user for stream ${stream}`,
  );

  return { success: true, message: "Download cancellation requested" };
}
