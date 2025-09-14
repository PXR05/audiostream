import { t } from "elysia";

export namespace AudioModel {
  export const uploadBody = t.Object({
    file: t.File(),
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
        { default: "uploadedAt" }
      )
    ),
    sortOrder: t.Optional(
      t.Union([t.Literal("asc"), t.Literal("desc")], { default: "desc" })
    ),
  });
  export type paginationQuery = typeof paginationQuery.static;

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
  });
  export type audioFile = typeof audioFile.static;

  export const uploadResponse = t.Object({
    success: t.Boolean(),
    id: t.String(),
    filename: t.String(),
    message: t.String(),
  });
  export type uploadResponse = typeof uploadResponse.static;

  export const youtubeResponse = t.Object({
    success: t.Boolean(),
    id: t.String(),
    filename: t.String(),
    title: t.String(),
    message: t.String(),
  });
  export type youtubeResponse = typeof youtubeResponse.static;

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
}
