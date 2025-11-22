ALTER TABLE "audio_file_users" DROP CONSTRAINT "audio_file_users_pkey";--> statement-breakpoint
ALTER TABLE "audio_file_users" ALTER COLUMN "id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "playlist_items" DROP CONSTRAINT "playlist_items_pkey";--> statement-breakpoint
ALTER TABLE "playlist_items" ALTER COLUMN "id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "audio_file_users" ADD CONSTRAINT "audio_file_users_id_pk" PRIMARY KEY("id");--> statement-breakpoint
ALTER TABLE "playlist_items" ADD CONSTRAINT "playlist_items_id_pk" PRIMARY KEY("id");