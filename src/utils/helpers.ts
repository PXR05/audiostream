import { env } from "elysia";

export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

export function getEnvLocale() {
  const string =
    env.LC_ALL || env.LC_MESSAGES || env.LANG || env.LANGUAGE || "en";
  return {
    lang: string.split("_")[0],
    country: string.split("_")[1]?.split(".")[0],
  };
}

export const UPLOADS_DIR = "uploads";
export const ALLOWED_AUDIO_EXTENSIONS = [
  ".mp3",
  ".wav",
  ".flac",
  ".m4a",
  ".aac",
  ".ogg",
];
