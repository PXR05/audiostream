export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

export const UPLOADS_DIR = "uploads";
export const MAX_FILE_SIZE = 100 * 1024 * 1024;
export const ALLOWED_AUDIO_EXTENSIONS = [
  ".mp3",
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
  extension: string = ".jpg"
): string {
  return `${audioId}_image${extension}`;
}
