PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_audio_files` (
	`id` text PRIMARY KEY NOT NULL,
	`youtube_id` text,
	`filename` text NOT NULL,
	`size` integer NOT NULL,
	`uploaded_at` integer DEFAULT (unixepoch()) NOT NULL,
	`image_file` text,
	`title` text,
	`artist` text,
	`album` text,
	`year` integer,
	`genre` text,
	`duration` real,
	`bitrate` real,
	`sample_rate` integer,
	`channels` integer,
	`format` text,
	`extra` text,
	`is_public` integer DEFAULT 0
);
--> statement-breakpoint
INSERT INTO `__new_audio_files`("id", "youtube_id", "filename", "size", "uploaded_at", "image_file", "title", "artist", "album", "year", "genre", "duration", "bitrate", "sample_rate", "channels", "format", "extra", "is_public") SELECT "id", "youtube_id", "filename", "size", "uploaded_at", "image_file", "title", "artist", "album", "year", "genre", "duration", "bitrate", "sample_rate", "channels", "format", "extra", "is_public" FROM `audio_files`;--> statement-breakpoint
DROP TABLE `audio_files`;--> statement-breakpoint
ALTER TABLE `__new_audio_files` RENAME TO `audio_files`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `audio_files_filename_unique` ON `audio_files` (`filename`);--> statement-breakpoint
CREATE INDEX `title_idx` ON `audio_files` (`title`);--> statement-breakpoint
CREATE INDEX `artist_idx` ON `audio_files` (`artist`);--> statement-breakpoint
CREATE INDEX `album_idx` ON `audio_files` (`album`);--> statement-breakpoint
CREATE INDEX `uploaded_at_idx` ON `audio_files` (`uploaded_at`);