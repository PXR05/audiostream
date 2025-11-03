CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_login_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE INDEX `user_username_idx` ON `users` (`username`);--> statement-breakpoint
CREATE INDEX `user_created_at_idx` ON `users` (`created_at`);--> statement-breakpoint
DROP TABLE `tokens`;