import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import { Readable } from "stream";
import { logger } from "./logger";

const S3_ENDPOINT = process.env.S3_ENDPOINT || "http://localhost:9000";
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || "rustfsadmin";
const S3_SECRET_KEY = process.env.S3_SECRET_KEY || "rustfsadmin";
const S3_BUCKET = process.env.S3_BUCKET || "audiostream";

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
  static async init(): Promise<void> {
    try {
      await s3Client.send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
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
        logger.info(`Bucket '${S3_BUCKET}' created`, { context: "STORAGE" });
      } else {
        logger.error(
          "Failed to create bucket: " + S3_BUCKET + " " + error.message,
          error,
          {
            context: "STORAGE",
          }
        );
        throw error;
      }
    }
  }

  static async upload(
    key: string,
    data: Buffer | Uint8Array,
    contentType?: string
  ): Promise<void> {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: data,
        ContentType: contentType,
      })
    );
  }

  static async uploadFromFile(
    key: string,
    filePath: string,
    contentType?: string
  ): Promise<void> {
    const file = Bun.file(filePath);
    const buffer = await file.arrayBuffer();

    await s3Client.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: Buffer.from(buffer),
        ContentType: contentType,
      })
    );
  }

  static async download(key: string): Promise<Buffer> {
    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
      })
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
  }

  static async getStream(
    key: string,
    range?: { start: number; end: number }
  ): Promise<{
    stream: Readable;
    contentLength: number;
    contentType: string;
    totalSize: number;
    range?: { start: number; end: number };
  }> {
    const rangeHeader = range ? `bytes=${range.start}-${range.end}` : undefined;

    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Range: rangeHeader,
      })
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
  }

  static async delete(key: string): Promise<void> {
    await s3Client.send(
      new DeleteObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
      })
    );
  }

  static async exists(key: string): Promise<boolean> {
    try {
      await s3Client.send(
        new HeadObjectCommand({
          Bucket: S3_BUCKET,
          Key: key,
        })
      );
      return true;
    } catch {
      return false;
    }
  }

  static async getMetadata(
    key: string
  ): Promise<{ size: number; contentType: string } | null> {
    try {
      const response = await s3Client.send(
        new HeadObjectCommand({
          Bucket: S3_BUCKET,
          Key: key,
        })
      );
      return {
        size: response.ContentLength || 0,
        contentType: response.ContentType || "application/octet-stream",
      };
    } catch {
      return null;
    }
  }
}
