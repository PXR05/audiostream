ALTER TABLE "audio_files"
ADD COLUMN "isrc" text;
--> statement-breakpoint
ALTER TABLE "audio_files"
ADD CONSTRAINT "audio_files_isrc_non_empty" CHECK (
        "isrc" IS NULL
        OR length(trim("isrc")) > 0
    );
--> statement-breakpoint
CREATE INDEX "isrc_idx" ON "audio_files" USING btree ("isrc");