import { t } from "elysia";

export namespace AudioModel {
  export const uploadBody = t.Object({
    file: t.Optional(t.File()),
    files: t.Optional(t.Union([t.File(), t.Array(t.File())])),
  });
  export type uploadBody = typeof uploadBody.static;

  export const youtubeBody = t.Object({
    url: t.String({ format: "uri" }),
  });
  export type youtubeBody = typeof youtubeBody.static;

  export const audioParams = t.Object({
    id: t.String(),
  });
  export type audioParams = typeof audioParams.static;

  export const paginationQuery = t.Object({
    page: t.Optional(t.Number({ minimum: 1, default: 1 })),
    limit: t.Optional(t.Number({ minimum: 1, maximum: 100, default: 20 })),
    sortBy: t.Optional(
      t.Union(
        [
          t.Literal("filename"),
          t.Literal("size"),
          t.Literal("uploadedAt"),
          t.Literal("title"),
        ],
        { default: "uploadedAt" },
      ),
    ),
    sortOrder: t.Optional(
      t.Union([t.Literal("asc"), t.Literal("desc")], { default: "desc" }),
    ),
    lastFetchedAt: t.Optional(t.Number()),
  });
  export type paginationQuery = typeof paginationQuery.static;

  export const searchQuery = t.Object({
    q: t.String({ minLength: 1 }),
    page: t.Optional(t.Number({ minimum: 1, default: 1 })),
    limit: t.Optional(t.Number({ minimum: 1, maximum: 100, default: 20 })),
  });
  export type searchQuery = typeof searchQuery.static;

  export const searchSuggestionsQuery = t.Object({
    q: t.String({ minLength: 1 }),
    limit: t.Optional(t.Number({ minimum: 1, maximum: 20, default: 5 })),
  });
  export type searchSuggestionsQuery = typeof searchSuggestionsQuery.static;

  export const randomQuery = t.Object({
    page: t.Optional(t.Number({ minimum: 1, default: 1 })),
    limit: t.Optional(t.Number({ minimum: 1, maximum: 100, default: 20 })),
    seed: t.Optional(t.String()),
    firstTrackId: t.Optional(t.String()),
  });
  export type randomQuery = typeof randomQuery.static;

  export const audioMetadata = t.Object({
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
  });
  export type audioMetadata = typeof audioMetadata.static;

  export const audioFile = t.Object({
    id: t.String(),
    filename: t.String(),
    size: t.Number(),
    uploadedAt: t.Date(),
    metadata: t.Optional(audioMetadata),
    imageFile: t.Optional(t.String()),
    youtubeId: t.Optional(t.String()),
  });
  export type audioFile = typeof audioFile.static;

  export const uploadResponse = t.Object({
    success: t.Boolean(),
    id: t.String(),
    filename: t.String(),
    imageFile: t.Optional(t.String()),
    message: t.String(),
  });
  export type uploadResponse = typeof uploadResponse.static;

  export const multiUploadResponse = t.Object({
    success: t.Boolean(),
    results: t.Array(
      t.Union([
        uploadResponse,
        t.Object({
          success: t.Literal(false),
          filename: t.String(),
          error: t.String(),
        }),
      ]),
    ),
    totalFiles: t.Number(),
    successfulUploads: t.Number(),
    failedUploads: t.Number(),
    message: t.String(),
  });
  export type multiUploadResponse = typeof multiUploadResponse.static;

  export const youtubeResponse = t.Object({
    success: t.Boolean(),
    id: t.String(),
    playlistItemId: t.Optional(t.String()),
    filename: t.String(),
    title: t.String(),
    imageFile: t.Optional(t.String()),
    message: t.String(),
    isExisting: t.Optional(t.Boolean()),
  });
  export type youtubeResponse = typeof youtubeResponse.static;

  export const youtubePlaylistResponse = t.Object({
    success: t.Boolean(),
    isPlaylist: t.Literal(true),
    playlistId: t.String(),
    playlistTitle: t.String(),
    results: t.Array(
      t.Union([
        youtubeResponse,
        t.Object({
          success: t.Literal(false),
          title: t.String(),
          error: t.String(),
        }),
      ]),
    ),
    totalVideos: t.Number(),
    successfulDownloads: t.Number(),
    failedDownloads: t.Number(),
    message: t.String(),
  });
  export type youtubePlaylistResponse = typeof youtubePlaylistResponse.static;

  export const audioListResponse = t.Object({
    files: t.Array(audioFile),
    count: t.Number(),
    page: t.Number(),
    limit: t.Number(),
    totalPages: t.Number(),
    hasNext: t.Boolean(),
    hasPrev: t.Boolean(),
  });
  export type audioListResponse = typeof audioListResponse.static;

  export const audioDetailResponse = t.Object({
    file: audioFile,
  });
  export type audioDetailResponse = typeof audioDetailResponse.static;

  export const deleteResponse = t.Object({
    success: t.Boolean(),
    message: t.String(),
  });
  export type deleteResponse = typeof deleteResponse.static;

  export const errorResponse = t.Object({
    error: t.String(),
    message: t.Optional(t.String()),
  });
  export type errorResponse = typeof errorResponse.static;

  export const searchSuggestion = t.Object({
    type: t.Union([
      t.Literal("title"),
      t.Literal("artist"),
      t.Literal("album"),
    ]),
    value: t.String(),
    score: t.Number(),
  });
  export type searchSuggestion = typeof searchSuggestion.static;

  export const searchSuggestionsResponse = t.Object({
    suggestions: t.Array(searchSuggestion),
  });
  export type searchSuggestionsResponse =
    typeof searchSuggestionsResponse.static;

  export const youtubeProgressEvent = t.Object({
    type: t.Union([
      t.Literal("progress"),
      t.Literal("complete"),
      t.Literal("error"),
      t.Literal("info"),
      t.Literal("cancelled"),
    ]),
    message: t.String(),
    data: t.Optional(
      t.Object({
        percent: t.Optional(t.Number()),
        speed: t.Optional(t.String()),
        eta: t.Optional(t.String()),
        downloaded: t.Optional(t.String()),
        totalSize: t.Optional(t.String()),
      }),
    ),
    playlistTitle: t.Optional(t.String()),
    playlistTotal: t.Optional(t.Number()),
    playlistCurrent: t.Optional(t.Number()),
    videoTitle: t.Optional(t.String()),
    result: t.Optional(t.Union([youtubeResponse, youtubePlaylistResponse])),
  });
  export type youtubeProgressEvent = typeof youtubeProgressEvent.static;

  export const youtubeSearchQuery = t.Object({
    q: t.String({ minLength: 1 }),
  });
  export type youtubeSearchQuery = typeof youtubeSearchQuery.static;

  export const youtubeSearchResult = t.Object({
    videoId: t.String(),
    title: t.String(),
    artist: t.String(),
    thumbnail: t.String(),
  });
  export type youtubeSearchResult = typeof youtubeSearchResult.static;

  export const youtubeSearchResponse = t.Array(youtubeSearchResult);
  export type youtubeSearchResponse = typeof youtubeSearchResponse.static;
}
