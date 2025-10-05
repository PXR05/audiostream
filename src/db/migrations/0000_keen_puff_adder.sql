CREATE TABLE `audio_files` (
	`id` text PRIMARY KEY NOT NULL,
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
	`format` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audio_files_filename_unique` ON `audio_files` (`filename`);