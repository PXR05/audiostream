import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import { existsSync, createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { Readable } from "stream";
import { UPLOADS_DIR } from "./helpers";
import { logger } from "./logger";

const S3_ENDPOINT = process.env.S3_ENDPOINT || "http://localhost:9000";
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || "rustfsadmin";
const S3_SECRET_KEY = process.env.S3_SECRET_KEY || "rustfsadmin";
const S3_BUCKET = process.env.S3_BUCKET || "audiostream";
const LOCAL_FALLBACK_DIR =
  process.env.STORAGE_LOCAL_FALLBACK_DIR || UPLOADS_DIR;
const ALLOW_LOCAL_FALLBACK =
  process.env.STORAGE_LOCAL_FALLBACK_ENABLED !== "false";

const CONTENT_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".webm": "audio/webm",
  ".opus": "audio/opus",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

logger.info(`Using S3 endpoint: ${S3_ENDPOINT}`, { context: "STORAGE" });
logger.info(`Using local fallback directory: ${LOCAL_FALLBACK_DIR}`, {
  context: "STORAGE",
});

const s3Client = new S3Client({
  endpoint: S3_ENDPOINT,
  region: "us-east-1",
  credentials: {
    accessKeyId: S3_ACCESS_KEY,
    secretAccessKey: S3_SECRET_KEY,
  },
  forcePathStyle: true,
});

export abstract class Storage {
  private static localFallbackEnabled = false;
  private static s3Available = true;
  private static hasLoggedS3Fallback = false;

  static async init(): Promise<void> {
    try {
      await s3Client.send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
      this.s3Available = true;
      logger.info(`Bucket '${S3_BUCKET}' exists`, { context: "STORAGE" });
    } catch (error: any) {
      if (
        error.name === "NotFound" ||
        error.$metadata?.httpStatusCode === 404
      ) {
        logger.info(`Creating bucket '${S3_BUCKET}'...`, {
          context: "STORAGE",
        });
        await s3Client.send(new CreateBucketCommand({ Bucket: S3_BUCKET }));
        this.s3Available = true;
        logger.info(`Bucket '${S3_BUCKET}' created`, { context: "STORAGE" });
      } else {
        this.s3Available = false;
        logger.error(
          "Failed to create bucket: " + S3_BUCKET + " " + JSON.stringify(error),
          error,
          {
            context: "STORAGE",
          },
        );
        throw error;
      }
    }
  }

  static async enableLocalFallback(reason?: string): Promise<void> {
    if (!ALLOW_LOCAL_FALLBACK) {
      throw new Error(
        "Local fallback is disabled (STORAGE_LOCAL_FALLBACK_ENABLED=false)",
      );
    }

    await mkdir(LOCAL_FALLBACK_DIR, { recursive: true });

    this.localFallbackEnabled = true;
    this.s3Available = false;

    await logger.warn("Local fallback storage mode enabled", {
      context: "STORAGE",
    });

    if (reason) {
      await logger.warn(`Local fallback reason: ${reason}`, {
        context: "STORAGE",
      });
    }
  }

  static isLocalFallbackEnabled(): boolean {
    return this.localFallbackEnabled;
  }

  static getLocalFallbackDir(): string {
    return LOCAL_FALLBACK_DIR;
  }

  private static getContentTypeFromKey(key: string): string {
    const ext = extname(key).toLowerCase();
    return CONTENT_TYPES[ext] || "application/octet-stream";
  }

  private static normalizeKey(key: string): string {
    const normalized = key.replace(/\\/g, "/").replace(/^\/+/, "").trim();
    if (!normalized || normalized === ".") {
      throw new Error("Invalid storage key");
    }
    return normalized;
  }

  private static resolveLocalPath(key: string): string {
    const safeKey = this.normalizeKey(key);
    logger.debug(
      `Resolving local path for key: ${key}, normalized: ${safeKey}`,
      {
        context: "STORAGE",
      },
    );
    const root = resolve(LOCAL_FALLBACK_DIR);
    logger.debug(`Local fallback root directory: ${root}`, {
      context: "STORAGE",
    });
    const fullPath = resolve(root, ...safeKey.split("/").filter(Boolean));
    logger.debug(`Resolved local path: ${fullPath}`, {
      context: "STORAGE",
    });

    if (fullPath !== root && !fullPath.startsWith(root + sep)) {
      throw new Error(`Invalid storage key path: ${key}`);
    }

    return fullPath;
  }

  private static async maybeFallbackOnS3Error(
    operation: string,
    key: string,
    error: unknown,
  ): Promise<boolean> {
    if (!this.localFallbackEnabled) {
      return false;
    }

    this.s3Available = false;

    if (!this.hasLoggedS3Fallback) {
      this.hasLoggedS3Fallback = true;
      await logger.warn(
        `S3 unavailable during ${operation} for key '${key}', switching to local fallback`,
        {
          context: "STORAGE",
        },
      );
    }

    await logger.debug(
      `S3 error for ${operation}: ${error instanceof Error ? error.message : String(error)}`,
      undefined,
      { context: "STORAGE" },
    );

    return true;
  }

  private static async uploadLocal(
    key: string,
    data: Buffer | Uint8Array,
  ): Promise<void> {
    const localPath = this.resolveLocalPath(key);
    await mkdir(dirname(localPath), { recursive: true });
    await writeFile(localPath, data);
  }

  private static async downloadLocal(key: string): Promise<Buffer> {
    const localPath = this.resolveLocalPath(key);
    return await readFile(localPath);
  }

  private static async existsLocal(key: string): Promise<boolean> {
    try {
      const localPath = this.resolveLocalPath(key);
      return existsSync(localPath);
    } catch {
      return false;
    }
  }

  private static async getMetadataLocal(
    key: string,
  ): Promise<{ size: number; contentType: string } | null> {
    try {
      const localPath = this.resolveLocalPath(key);
      logger.debug(
        `Getting local metadata for key: ${key}, path: ${localPath}`,
        {
          context: "STORAGE",
        },
      );
      const fileStats = await stat(localPath);
      logger.debug(
        `Local file stats for key: ${key} - size: ${fileStats.size}, isFile: ${fileStats.isFile()}`,
        {
          context: "STORAGE",
        },
      );
      if (!fileStats.isFile()) return null;
      return {
        size: fileStats.size,
        contentType: this.getContentTypeFromKey(key),
      };
    } catch {
      return null;
    }
  }

  private static async getStreamLocal(
    key: string,
    range?: { start: number; end: number },
  ): Promise<{
    stream: Readable;
    contentLength: number;
    contentType: string;
    totalSize: number;
    range?: { start: number; end: number };
  }> {
    const localPath = this.resolveLocalPath(key);
    const fileStats = await stat(localPath);
    logger.debug(`Getting local stream for key: ${key}, path: ${localPath}`, {
      context: "STORAGE",
    });
    logger.debug(
      `Local file stats for key: ${key} - size: ${fileStats.size}, isFile: ${fileStats.isFile()}`,
      {
        context: "STORAGE",
      },
    );
    if (!fileStats.isFile()) {
      throw new Error(`Local fallback file not found: ${key}`);
    }

    const totalSize = fileStats.size;
    const contentType = this.getContentTypeFromKey(key);

    if (!range || totalSize === 0) {
      return {
        stream: createReadStream(localPath),
        contentLength: totalSize,
        contentType,
        totalSize,
      };
    }

    const maxOffset = Math.max(totalSize - 1, 0);
    const safeStart = Math.max(0, Math.min(range.start, maxOffset));
    const safeEnd = Math.max(safeStart, Math.min(range.end, maxOffset));

    return {
      stream: createReadStream(localPath, {
        start: safeStart,
        end: safeEnd,
      }),
      contentLength: safeEnd - safeStart + 1,
      contentType,
      totalSize,
      range: {
        start: safeStart,
        end: safeEnd,
      },
    };
  }

  private static async deleteLocal(key: string): Promise<void> {
    const localPath = this.resolveLocalPath(key);
    await rm(localPath, { force: true });
  }

  static async upload(
    key: string,
    data: Buffer | Uint8Array,
    contentType?: string,
  ): Promise<void> {
    if (!this.s3Available && this.localFallbackEnabled) {
      await this.uploadLocal(key, data);
      return;
    }

    try {
      await s3Client.send(
        new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: key,
          Body: data,
          ContentType: contentType,
        }),
      );
    } catch (error) {
      const shouldFallback = await this.maybeFallbackOnS3Error(
        "upload",
        key,
        error,
      );
      if (!shouldFallback) throw error;
      await this.uploadLocal(key, data);
    }
  }

  static async uploadFromFile(
    key: string,
    filePath: string,
    contentType?: string,
  ): Promise<void> {
    const buffer = await readFile(filePath);
    await this.upload(key, buffer, contentType);
  }

  static async download(key: string): Promise<Buffer> {
    if (!this.s3Available && this.localFallbackEnabled) {
      return await this.downloadLocal(key);
    }

    try {
      const response = await s3Client.send(
        new GetObjectCommand({
          Bucket: S3_BUCKET,
          Key: key,
        }),
      );

      if (!response.Body) {
        throw new Error("Empty response body");
      }

      const stream = response.Body as Readable;
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } catch (error) {
      const shouldFallback = await this.maybeFallbackOnS3Error(
        "download",
        key,
        error,
      );
      if (!shouldFallback) throw error;
      return await this.downloadLocal(key);
    }
  }

  static async getStream(
    key: string,
    range?: { start: number; end: number },
  ): Promise<{
    stream: Readable;
    contentLength: number;
    contentType: string;
    totalSize: number;
    range?: { start: number; end: number };
  }> {
    if (!this.s3Available && this.localFallbackEnabled) {
      return await this.getStreamLocal(key, range);
    }

    const rangeHeader = range ? `bytes=${range.start}-${range.end}` : undefined;

    try {
      const response = await s3Client.send(
        new GetObjectCommand({
          Bucket: S3_BUCKET,
          Key: key,
          Range: rangeHeader,
        }),
      );

      if (!response.Body) {
        throw new Error("Empty response body");
      }

      const totalSize = response.ContentRange
        ? parseInt(response.ContentRange.split("/")[1], 10)
        : response.ContentLength || 0;

      return {
        stream: response.Body as Readable,
        contentLength: response.ContentLength || 0,
        contentType: response.ContentType || "application/octet-stream",
        totalSize,
        range,
      };
    } catch (error) {
      const shouldFallback = await this.maybeFallbackOnS3Error(
        "getStream",
        key,
        error,
      );
      if (!shouldFallback) throw error;
      return await this.getStreamLocal(key, range);
    }
  }

  static async delete(key: string): Promise<void> {
    if (!this.s3Available && this.localFallbackEnabled) {
      await this.deleteLocal(key);
      return;
    }

    try {
      await s3Client.send(
        new DeleteObjectCommand({
          Bucket: S3_BUCKET,
          Key: key,
        }),
      );
    } catch (error) {
      const shouldFallback = await this.maybeFallbackOnS3Error(
        "delete",
        key,
        error,
      );
      if (!shouldFallback) throw error;
      await this.deleteLocal(key);
    }
  }

  static async exists(key: string): Promise<boolean> {
    if (!this.s3Available && this.localFallbackEnabled) {
      return await this.existsLocal(key);
    }

    try {
      await s3Client.send(
        new HeadObjectCommand({
          Bucket: S3_BUCKET,
          Key: key,
        }),
      );
      return true;
    } catch (error) {
      const shouldFallback = await this.maybeFallbackOnS3Error(
        "exists",
        key,
        error,
      );
      if (shouldFallback) {
        return await this.existsLocal(key);
      }
      return false;
    }
  }

  static async getMetadata(
    key: string,
  ): Promise<{ size: number; contentType: string } | null> {
    if (!this.s3Available && this.localFallbackEnabled) {
      return await this.getMetadataLocal(key);
    }

    try {
      const response = await s3Client.send(
        new HeadObjectCommand({
          Bucket: S3_BUCKET,
          Key: key,
        }),
      );
      return {
        size: response.ContentLength || 0,
        contentType: response.ContentType || "application/octet-stream",
      };
    } catch (error) {
      const shouldFallback = await this.maybeFallbackOnS3Error(
        "getMetadata",
        key,
        error,
      );
      if (shouldFallback) {
        return await this.getMetadataLocal(key);
      }
      return null;
    }
  }
}
