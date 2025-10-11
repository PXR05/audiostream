-- Delete existing tokens as they are incompatible with the new structure
DELETE FROM `tokens`;--> statement-breakpoint
DROP INDEX `tokens_hash_unique`;--> statement-breakpoint
ALTER TABLE `tokens` ADD `user_id` text NOT NULL;--> statement-breakpoint
ALTER TABLE `tokens` ADD `token_id` text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `tokens_token_id_unique` ON `tokens` (`token_id`);--> statement-breakpoint
CREATE INDEX `token_user_id_idx` ON `tokens` (`user_id`);