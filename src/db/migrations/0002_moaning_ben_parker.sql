ALTER TABLE "audio_file_users" DROP CONSTRAINT "audio_file_users_pkey";--> statement-breakpoint
ALTER TABLE "audio_file_users" ALTER COLUMN "id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "audio_file_users" ADD CONSTRAINT "audio_file_users_id_pk" PRIMARY KEY("id");--> statement-breakpoint
ALTER TABLE "audio_file_users" ADD CONSTRAINT "audio_file_users_audio_file_id_user_id_pk" PRIMARY KEY("audio_file_id","user_id");
