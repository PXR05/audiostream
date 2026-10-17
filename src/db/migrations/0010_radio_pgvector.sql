CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audio_embeddings" (
  "audio_id" text PRIMARY KEY NOT NULL,
  "model_name" text NOT NULL,
  "embedding" vector(1280),
  "analysis_version" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "audio_embeddings_audio_id_audio_files_id_fk"
    FOREIGN KEY ("audio_id") REFERENCES "audio_files"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audio_embeddings_model_idx" ON "audio_embeddings" ("model_name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audio_embeddings_hnsw_idx" ON "audio_embeddings" USING hnsw ("embedding" vector_cosine_ops);
