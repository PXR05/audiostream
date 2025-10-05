CREATE INDEX `title_idx` ON `audio_files` (`title`);--> statement-breakpoint
CREATE INDEX `artist_idx` ON `audio_files` (`artist`);--> statement-breakpoint
CREATE INDEX `album_idx` ON `audio_files` (`album`);--> statement-breakpoint
CREATE INDEX `uploaded_at_idx` ON `audio_files` (`uploaded_at`);