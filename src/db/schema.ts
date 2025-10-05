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
  },
  (table) => ({
    titleIdx: index("title_idx").on(table.title),
    artistIdx: index("artist_idx").on(table.artist),
    albumIdx: index("album_idx").on(table.album),
    uploadedAtIdx: index("uploaded_at_idx").on(table.uploadedAt),
  })
);

export type AudioFile = typeof audioFiles.$inferSelect;
export type NewAudioFile = typeof audioFiles.$inferInsert;
