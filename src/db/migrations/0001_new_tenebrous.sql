ALTER TABLE "playlist_items" DROP CONSTRAINT "playlist_items_pkey";--> statement-breakpoint
ALTER TABLE "playlist_items" ALTER COLUMN "id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "playlist_items" ADD CONSTRAINT "playlist_items_id_pk" PRIMARY KEY("id");--> statement-breakpoint
ALTER TABLE "playlist_items" ADD CONSTRAINT "playlist_items_playlist_id_audio_id_pk" PRIMARY KEY("playlist_id","audio_id");
