CREATE TABLE `playlist_items` (
	`id` text PRIMARY KEY NOT NULL,
	`playlist_id` text NOT NULL,
	`audio_id` text NOT NULL,
	`position` integer NOT NULL,
	`added_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`audio_id`) REFERENCES `audio_files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `playlist_items_playlist_id_idx` ON `playlist_items` (`playlist_id`);--> statement-breakpoint
CREATE INDEX `playlist_items_audio_id_idx` ON `playlist_items` (`audio_id`);--> statement-breakpoint
CREATE INDEX `playlist_items_playlist_position_idx` ON `playlist_items` (`playlist_id`,`position`);--> statement-breakpoint
CREATE TABLE `playlists` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`user_id` text NOT NULL,
	`cover_image` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `playlist_user_id_idx` ON `playlists` (`user_id`);--> statement-breakpoint
CREATE INDEX `playlist_created_at_idx` ON `playlists` (`created_at`);