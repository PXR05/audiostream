ALTER TABLE "audio_files" ADD COLUMN IF NOT EXISTS "album_artist" text;
--> statement-breakpoint
ALTER TABLE "audio_files" ADD COLUMN IF NOT EXISTS "artists" text[];
--> statement-breakpoint
ALTER TABLE "audio_files" ADD COLUMN IF NOT EXISTS "track_number" integer;
--> statement-breakpoint
ALTER TABLE "audio_files" ADD COLUMN IF NOT EXISTS "total_tracks" integer;
--> statement-breakpoint
ALTER TABLE "audio_files" ADD COLUMN IF NOT EXISTS "disc_number" integer;
--> statement-breakpoint
ALTER TABLE "audio_files" ADD COLUMN IF NOT EXISTS "total_discs" integer;
--> statement-breakpoint
ALTER TABLE "audio_files" ADD COLUMN IF NOT EXISTS "compilation" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "audio_files" ADD COLUMN IF NOT EXISTS "replay_gain_track_gain" real;
--> statement-breakpoint
ALTER TABLE "audio_files" ADD COLUMN IF NOT EXISTS "replay_gain_album_gain" real;
--> statement-breakpoint
ALTER TABLE "audio_files" ADD COLUMN IF NOT EXISTS "replay_gain_track_peak" real;
--> statement-breakpoint
ALTER TABLE "audio_files" ADD COLUMN IF NOT EXISTS "replay_gain_album_peak" real;
--> statement-breakpoint
ALTER TABLE "audio_files" ADD COLUMN IF NOT EXISTS "codec" text;
--> statement-breakpoint
ALTER TABLE "audio_files" ADD COLUMN IF NOT EXISTS "lossless" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "audio_files" ADD COLUMN IF NOT EXISTS "lyrics" text;
--> statement-breakpoint
ALTER TABLE "audio_files" ADD COLUMN IF NOT EXISTS "genre_tmp" text[];
--> statement-breakpoint
UPDATE "audio_files"
SET "genre_tmp" = CASE
  WHEN "genre" IS NULL OR btrim("genre") = '' THEN NULL
  WHEN left(btrim("genre"), 1) = '[' THEN
    ARRAY(SELECT jsonb_array_elements_text("genre"::jsonb))
  ELSE ARRAY["genre"]
END;
--> statement-breakpoint
ALTER TABLE "audio_files" DROP COLUMN "genre";
--> statement-breakpoint
ALTER TABLE "audio_files" RENAME COLUMN "genre_tmp" TO "genre";
--> statement-breakpoint
ALTER TABLE "audio_files"
  ALTER COLUMN "extra" TYPE jsonb
  USING CASE
    WHEN "extra" IS NULL OR btrim("extra") = '' THEN NULL
    ELSE "extra"::jsonb
  END;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "album_artist_idx" ON "audio_files" ("album_artist");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "album_track_order_idx" ON "audio_files" ("album", "disc_number", "track_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "genre_gin_idx" ON "audio_files" USING gin ("genre");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artists_gin_idx" ON "audio_files" USING gin ("artists");
