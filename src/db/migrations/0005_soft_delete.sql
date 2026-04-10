ALTER TABLE "audio_files"
ADD COLUMN "deleted_at" timestamp;
--> statement-breakpoint
ALTER TABLE "audio_file_users"
ADD COLUMN "deleted_at" timestamp;
--> statement-breakpoint
ALTER TABLE "playlists"
ADD COLUMN "deleted_at" timestamp;
--> statement-breakpoint
ALTER TABLE "playlist_items"
ADD COLUMN "deleted_at" timestamp;
