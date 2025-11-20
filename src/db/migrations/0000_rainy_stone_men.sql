CREATE TABLE "audio_file_users" (
	"id" text PRIMARY KEY NOT NULL,
	"audio_file_id" text NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audio_files" (
	"id" text PRIMARY KEY NOT NULL,
	"youtube_id" text,
	"filename" text NOT NULL,
	"size" integer NOT NULL,
	"uploaded_at" timestamp DEFAULT now() NOT NULL,
	"image_file" text,
	"title" text,
	"artist" text,
	"album" text,
	"year" integer,
	"genre" text,
	"duration" real,
	"bitrate" real,
	"sample_rate" integer,
	"channels" integer,
	"format" text,
	"extra" text,
	"is_public" integer DEFAULT 0,
	CONSTRAINT "audio_files_filename_unique" UNIQUE("filename")
);
--> statement-breakpoint
CREATE TABLE "playlist_items" (
	"id" text PRIMARY KEY NOT NULL,
	"playlist_id" text NOT NULL,
	"audio_id" text NOT NULL,
	"position" integer NOT NULL,
	"added_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playlists" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"user_id" text NOT NULL,
	"cover_image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_login_at" timestamp,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "audio_file_users" ADD CONSTRAINT "audio_file_users_audio_file_id_audio_files_id_fk" FOREIGN KEY ("audio_file_id") REFERENCES "public"."audio_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_file_users" ADD CONSTRAINT "audio_file_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_items" ADD CONSTRAINT "playlist_items_playlist_id_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_items" ADD CONSTRAINT "playlist_items_audio_id_audio_files_id_fk" FOREIGN KEY ("audio_id") REFERENCES "public"."audio_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audio_file_users_audio_file_id_idx" ON "audio_file_users" USING btree ("audio_file_id");--> statement-breakpoint
CREATE INDEX "audio_file_users_user_id_idx" ON "audio_file_users" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "title_idx" ON "audio_files" USING btree ("title");--> statement-breakpoint
CREATE INDEX "artist_idx" ON "audio_files" USING btree ("artist");--> statement-breakpoint
CREATE INDEX "album_idx" ON "audio_files" USING btree ("album");--> statement-breakpoint
CREATE INDEX "uploaded_at_idx" ON "audio_files" USING btree ("uploaded_at");--> statement-breakpoint
CREATE INDEX "playlist_items_playlist_id_idx" ON "playlist_items" USING btree ("playlist_id");--> statement-breakpoint
CREATE INDEX "playlist_items_audio_id_idx" ON "playlist_items" USING btree ("audio_id");--> statement-breakpoint
CREATE INDEX "playlist_items_playlist_position_idx" ON "playlist_items" USING btree ("playlist_id","position");--> statement-breakpoint
CREATE INDEX "playlist_user_id_idx" ON "playlists" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "playlist_created_at_idx" ON "playlists" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "user_username_idx" ON "users" USING btree ("username");--> statement-breakpoint
CREATE INDEX "user_created_at_idx" ON "users" USING btree ("created_at");