export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

export const UPLOADS_DIR = "uploads";
export const TEMP_DIR = "temp";

function parseSizeMbEnv(
  value: string | undefined,
  defaultMb: number,
): number {
  if (value === undefined || value.trim() === "") {
    return defaultMb * 1024 * 1024;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultMb * 1024 * 1024;
  }
  return Math.floor(parsed * 1024 * 1024);
}

export const MAX_FILE_SIZE = parseSizeMbEnv(process.env.MAX_FILE_SIZE_MB, 100);
export const MAX_IMAGE_SIZE = parseSizeMbEnv(
  process.env.MAX_IMAGE_SIZE_MB,
  10,
);
export const ALLOWED_AUDIO_EXTENSIONS = [
  ".mp3",
  ".opus",
  ".wav",
  ".flac",
  ".m4a",
  ".aac",
  ".ogg",
];
export const ALLOWED_IMAGE_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
];

export function getImageFileName(
  audioId: string,
  extension: string = ".jpg",
): string {
  return `${audioId}_image${extension}`;
}

export function getWebPImageFileName(audioId: string): string {
  return `${audioId}_image.webp`;
}
