CREATE TABLE `audio_file_users` (
	`id` text PRIMARY KEY NOT NULL,
	`audio_file_id` text NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`audio_file_id`) REFERENCES `audio_files`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `audio_file_users_audio_file_id_idx` ON `audio_file_users` (`audio_file_id`);--> statement-breakpoint
CREATE INDEX `audio_file_users_user_id_idx` ON `audio_file_users` (`user_id`);--> statement-breakpoint
ALTER TABLE `audio_files` ADD `is_public` integer DEFAULT 0 NOT NULL;