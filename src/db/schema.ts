import {
  pgTable,
  text,
  integer,
  real,
  index,
  timestamp,
  primaryKey,
} from "drizzle-orm/pg-core";

export const audioFiles = pgTable(
  "audio_files",
  {
    id: text("id").primaryKey(),
    youtubeId: text("youtube_id"),
    filename: text("filename").notNull().unique(),
    size: integer("size").notNull(),
    uploadedAt: timestamp("uploaded_at").defaultNow().notNull(),
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
    isPublic: integer("is_public").default(0),
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

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").notNull().default("user"), // 'admin' or 'user'
    createdAt: timestamp("created_at").defaultNow().notNull(),
    lastLoginAt: timestamp("last_login_at"),
  },
  (table) => ({
    usernameIdx: index("user_username_idx").on(table.username),
    createdAtIdx: index("user_created_at_idx").on(table.createdAt),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export const audioFileUsers = pgTable(
  "audio_file_users",
  {
    id: text("id"),
    audioFileId: text("audio_file_id")
      .notNull()
      .references(() => audioFiles.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    primaryKey({ columns: [table.audioFileId, table.userId] }),
    index("audio_file_users_audio_file_id_idx").on(table.audioFileId),
    index("audio_file_users_user_id_idx").on(table.userId),
  ],
);

export type AudioFileUser = typeof audioFileUsers.$inferSelect;
export type NewAudioFileUser = typeof audioFileUsers.$inferInsert;

export const playlists = pgTable(
  "playlists",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    userId: text("user_id").notNull(),
    coverImage: text("cover_image"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    userIdIdx: index("playlist_user_id_idx").on(table.userId),
    createdAtIdx: index("playlist_created_at_idx").on(table.createdAt),
  }),
);

export type Playlist = typeof playlists.$inferSelect;
export type NewPlaylist = typeof playlists.$inferInsert;

export const playlistItems = pgTable(
  "playlist_items",
  {
    id: text("id"),
    playlistId: text("playlist_id")
      .notNull()
      .references(() => playlists.id, { onDelete: "cascade" }),
    audioId: text("audio_id")
      .notNull()
      .references(() => audioFiles.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    addedAt: timestamp("added_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    primaryKey({ columns: [table.playlistId, table.audioId] }),
    index("playlist_items_playlist_id_idx").on(table.playlistId),
    index("playlist_items_audio_id_idx").on(table.audioId),
    index("playlist_items_playlist_position_idx").on(
      table.playlistId,
      table.position,
    ),
  ],
);

export type PlaylistItem = typeof playlistItems.$inferSelect;
export type NewPlaylistItem = typeof playlistItems.$inferInsert;
