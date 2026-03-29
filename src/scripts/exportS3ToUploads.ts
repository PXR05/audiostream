import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { existsSync, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { logger } from "../utils/logger";
import { UPLOADS_DIR } from "../utils/helpers";

const CONTEXT = "S3_EXPORT";

const S3_ENDPOINT = process.env.S3_ENDPOINT || "http://localhost:9000";
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || "rustfsadmin";
const S3_SECRET_KEY = process.env.S3_SECRET_KEY || "rustfsadmin";
const S3_BUCKET = process.env.S3_BUCKET || "audiostream";

const EXPORT_DEST_DIR = process.env.EXPORT_S3_DEST || UPLOADS_DIR;
const EXPORT_PREFIX = process.env.EXPORT_S3_PREFIX || "";
const OVERWRITE = process.env.EXPORT_S3_OVERWRITE !== "true";
const FAIL_ON_ERROR = process.env.EXPORT_S3_FAIL_ON_ERROR !== "false";

const s3Client = new S3Client({
  endpoint: S3_ENDPOINT,
  region: "us-east-1",
  credentials: {
    accessKeyId: S3_ACCESS_KEY,
    secretAccessKey: S3_SECRET_KEY,
  },
  forcePathStyle: true,
});

type ExportSummary = {
  listed: number;
  exported: number;
  skipped: number;
  failed: number;
  bytes: number;
};

function normalizeKey(key: string): string {
  return key.replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

function resolveDestinationPath(destinationRoot: string, key: string): string {
  const safeKey = normalizeKey(key);
  if (!safeKey || safeKey === ".") {
    throw new Error(`Invalid S3 object key: ${key}`);
  }

  const root = resolve(destinationRoot);
  const fullPath = resolve(root, ...safeKey.split("/").filter(Boolean));

  if (fullPath !== root && !fullPath.startsWith(root + sep)) {
    throw new Error(`Unsafe key path detected: ${key}`);
  }

  return fullPath;
}

async function listAllObjectKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;

  while (true) {
    const response = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: prefix || undefined,
        ContinuationToken: continuationToken,
      }),
    );

    const pageKeys = (response.Contents || [])
      .map((entry) => entry.Key)
      .filter((key): key is string => !!key && !key.endsWith("/"));

    keys.push(...pageKeys);

    if (!response.IsTruncated || !response.NextContinuationToken) {
      break;
    }

    continuationToken = response.NextContinuationToken;
  }

  return keys;
}

async function writeObjectToFile(
  key: string,
  destinationPath: string,
): Promise<number> {
  const response = await s3Client.send(
    new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
    }),
  );

  if (!response.Body) {
    throw new Error("Empty object body");
  }

  await mkdir(dirname(destinationPath), { recursive: true });

  const tmpPath = `${destinationPath}.exporting-${Date.now()}`;

  try {
    const body = response.Body as unknown;

    if (body instanceof Readable) {
      const writer = createWriteStream(tmpPath, { flags: "w" });
      await pipeline(body, writer);
    } else if (
      typeof body === "object" &&
      body !== null &&
      "transformToByteArray" in body &&
      typeof (body as { transformToByteArray: () => Promise<Uint8Array> })
        .transformToByteArray === "function"
    ) {
      const bytes = await (
        body as { transformToByteArray: () => Promise<Uint8Array> }
      ).transformToByteArray();
      await writeFile(tmpPath, bytes);
    } else {
      throw new Error("Unsupported response body type");
    }

    if (existsSync(destinationPath)) {
      await rm(destinationPath, { force: true });
    }

    await rename(tmpPath, destinationPath);

    const fileStats = await stat(destinationPath);
    return fileStats.size;
  } catch (error) {
    await rm(tmpPath, { force: true });
    throw error;
  }
}

export async function exportS3ToUploads(): Promise<number> {
  const summary: ExportSummary = {
    listed: 0,
    exported: 0,
    skipped: 0,
    failed: 0,
    bytes: 0,
  };

  await logger.info(
    `Starting S3 export: endpoint=${S3_ENDPOINT}, bucket=${S3_BUCKET}, prefix=${EXPORT_PREFIX || "(all)"}, dest=${EXPORT_DEST_DIR}, overwrite=${OVERWRITE}`,
    { context: CONTEXT },
  );

  await mkdir(EXPORT_DEST_DIR, { recursive: true });

  const keys = await listAllObjectKeys(EXPORT_PREFIX);
  summary.listed = keys.length;

  await logger.info(`Found ${keys.length} objects to export`, {
    context: CONTEXT,
  });

  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];

    try {
      const destinationPath = resolveDestinationPath(EXPORT_DEST_DIR, key);

      if (!OVERWRITE && existsSync(destinationPath)) {
        summary.skipped += 1;
      } else {
        const written = await writeObjectToFile(key, destinationPath);
        summary.exported += 1;
        summary.bytes += written;
      }
    } catch (error) {
      summary.failed += 1;
      await logger.error(`Failed to export object: ${key}`, error, {
        context: CONTEXT,
      });

      if (FAIL_ON_ERROR) {
        await logger.error(
          "Stopping export due to FAIL_ON_ERROR=true",
          undefined,
          {
            context: CONTEXT,
          },
        );
        break;
      }
    }

    if ((i + 1) % 100 === 0 || i + 1 === keys.length) {
      await logger.info(
        `Progress ${i + 1}/${keys.length}: exported=${summary.exported}, skipped=${summary.skipped}, failed=${summary.failed}`,
        { context: CONTEXT },
      );
    }
  }

  await logger.info(
    `S3 export complete: listed=${summary.listed}, exported=${summary.exported}, skipped=${summary.skipped}, failed=${summary.failed}, bytes=${summary.bytes}`,
    { context: CONTEXT },
  );

  if (summary.failed > 0) {
    return 1;
  }

  return 0;
}

if (import.meta.main) {
  try {
    const exitCode = await exportS3ToUploads();
    process.exit(exitCode);
  } catch (error) {
    await logger.error("S3 export failed unexpectedly", error, {
      context: CONTEXT,
    });
    process.exit(1);
  }
}

export default exportS3ToUploads;
