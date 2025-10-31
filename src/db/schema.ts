import {
  sqliteTable,
  text,
  integer,
  real,
  index,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const audioFiles = sqliteTable(
  "audio_files",
  {
    id: text("id").primaryKey(),
    youtubeId: text("youtube_id"),
    filename: text("filename").notNull().unique(),
    size: integer("size").notNull(),
    uploadedAt: integer("uploaded_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    imageFile: text("image_file"),
    title: text("title"),
    artist: text("artist"),
    album: text("album"),
    year: integer("year"),
    genre: text("genre"),
    duration: real("duration"),
    bitrate: real("bitrate"),
    sampleRate: integer("sample_rate"),
    channels: integer("channels"),
    format: text("format"),
    extra: text("extra"),
  },
  (table) => ({
    titleIdx: index("title_idx").on(table.title),
    artistIdx: index("artist_idx").on(table.artist),
    albumIdx: index("album_idx").on(table.album),
    uploadedAtIdx: index("uploaded_at_idx").on(table.uploadedAt),
  }),
);

export type AudioFile = typeof audioFiles.$inferSelect;
export type NewAudioFile = typeof audioFiles.$inferInsert;

export const tokens = sqliteTable(
  "tokens",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    userId: text("user_id").notNull(),
    tokenId: text("token_id").notNull().unique(),
    hash: text("hash").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
  },
  (table) => ({
    createdAtIdx: index("token_created_at_idx").on(table.createdAt),
    userIdIdx: index("token_user_id_idx").on(table.userId),
  }),
);

export type Token = typeof tokens.$inferSelect;
export type NewToken = typeof tokens.$inferInsert;

export const playlists = sqliteTable(
  "playlists",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    userId: text("user_id").notNull(),
    coverImage: text("cover_image"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => ({
    userIdIdx: index("playlist_user_id_idx").on(table.userId),
    createdAtIdx: index("playlist_created_at_idx").on(table.createdAt),
  }),
);

export type Playlist = typeof playlists.$inferSelect;
export type NewPlaylist = typeof playlists.$inferInsert;

export const playlistItems = sqliteTable(
  "playlist_items",
  {
    id: text("id").primaryKey(),
    playlistId: text("playlist_id")
      .notNull()
      .references(() => playlists.id, { onDelete: "cascade" }),
    audioId: text("audio_id")
      .notNull()
      .references(() => audioFiles.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    addedAt: integer("added_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => ({
    playlistIdIdx: index("playlist_items_playlist_id_idx").on(table.playlistId),
    audioIdIdx: index("playlist_items_audio_id_idx").on(table.audioId),
    playlistPositionIdx: index("playlist_items_playlist_position_idx").on(
      table.playlistId,
      table.position,
    ),
  }),
);

export type PlaylistItem = typeof playlistItems.$inferSelect;
export type NewPlaylistItem = typeof playlistItems.$inferInsert;
