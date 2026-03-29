import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import { logger } from "../utils/logger";

const CONTEXT = "RUSTFS_BACKUP";

type Status = "copied" | "skipped" | "conflict" | "failed" | "dry-run";

type PartFile = {
  path: string;
  partNumber: number;
  size: number;
};

type SegmentCandidate = {
  dirPath: string;
  parts: PartFile[];
  totalBytes: number;
  mtimeMs: number;
};

type ObjectResult = {
  key: string;
  status: Status;
  reason?: string;
  objectDir: string;
  segmentDir?: string;
  destinationPath: string;
  partCount: number;
  expectedBytes: number;
  writtenBytes?: number;
  sourceSha256?: string;
  destinationSha256?: string;
};

type BackupSummary = {
  discovered: number;
  copied: number;
  skipped: number;
  conflicts: number;
  failed: number;
  dryRun: number;
  copiedBytes: number;
};

type BackupReport = {
  startedAt: string;
  finishedAt?: string;
  sourceDir: string;
  destinationDir: string;
  dryRun: boolean;
  overwrite: boolean;
  keepConflictCopy: boolean;
  verifyHash: boolean;
  maxFailures: number;
  maxConflicts: number;
  summary: BackupSummary;
  objects: ObjectResult[];
};

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function parseNonNegativeInt(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function toPosixPath(input: string): string {
  return input.replace(/\\/g, "/");
}

function sanitizeTimestampForFile(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function buildDestinationPath(destinationRoot: string, key: string): string {
  const segments = key.split("/").filter(Boolean);
  return join(destinationRoot, ...segments);
}

async function findObjectDirs(sourceRoot: string): Promise<string[]> {
  const objectDirs: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    const hasMetadata = entries.some(
      (entry) => entry.isFile() && entry.name === "xl.meta",
    );

    if (hasMetadata) {
      objectDirs.push(dir);
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      await walk(join(dir, entry.name));
    }
  }

  await walk(sourceRoot);
  return objectDirs.sort();
}

async function collectSegmentCandidates(
  objectDir: string,
): Promise<SegmentCandidate[]> {
  const entries = await readdir(objectDir, { withFileTypes: true });
  const candidates: SegmentCandidate[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const segmentDir = join(objectDir, entry.name);
    const segmentEntries = await readdir(segmentDir, { withFileTypes: true });
    const partFiles: PartFile[] = [];

    for (const segmentEntry of segmentEntries) {
      if (!segmentEntry.isFile()) continue;
      const match = /^part\.(\d+)$/i.exec(segmentEntry.name);
      if (!match) continue;

      const partPath = join(segmentDir, segmentEntry.name);
      const fileStats = await stat(partPath);
      partFiles.push({
        path: partPath,
        partNumber: Number.parseInt(match[1], 10),
        size: fileStats.size,
      });
    }

    if (partFiles.length === 0) continue;

    partFiles.sort((a, b) => a.partNumber - b.partNumber);

    const segmentStats = await stat(segmentDir);
    const totalBytes = partFiles.reduce((acc, part) => acc + part.size, 0);

    candidates.push({
      dirPath: segmentDir,
      parts: partFiles,
      totalBytes,
      mtimeMs: segmentStats.mtimeMs,
    });
  }

  candidates.sort((a, b) => {
    if (b.parts.length !== a.parts.length)
      return b.parts.length - a.parts.length;
    if (b.totalBytes !== a.totalBytes) return b.totalBytes - a.totalBytes;
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return a.dirPath.localeCompare(b.dirPath);
  });

  return candidates;
}

function findMissingParts(parts: PartFile[]): number[] {
  if (parts.length === 0) return [1];

  const missing: number[] = [];
  let expected = 1;

  for (const part of parts) {
    while (part.partNumber > expected) {
      missing.push(expected);
      expected += 1;
    }
    expected = part.partNumber + 1;
  }

  return missing;
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

async function hashParts(parts: PartFile[]): Promise<string> {
  const hash = createHash("sha256");
  for (const part of parts) {
    const stream = createReadStream(part.path);
    for await (const chunk of stream) {
      hash.update(chunk as Buffer);
    }
  }
  return hash.digest("hex");
}

async function writeReconstructedFile(
  parts: PartFile[],
  destinationPath: string,
): Promise<number> {
  await mkdir(dirname(destinationPath), { recursive: true });

  const tempPath = `${destinationPath}.rustfs-backup-partial-${Date.now()}`;
  const writer = createWriteStream(tempPath, { flags: "w" });

  try {
    for (const part of parts) {
      await pipeline(createReadStream(part.path), writer, { end: false });
    }

    await new Promise<void>((resolve, reject) => {
      writer.once("error", reject);
      writer.end(() => resolve());
    });

    if (existsSync(destinationPath)) {
      await rm(destinationPath, { force: true });
    }

    await rename(tempPath, destinationPath);
    const outputStats = await stat(destinationPath);
    return outputStats.size;
  } catch (error) {
    try {
      writer.destroy();
    } catch {}
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function ensureWritableDirectory(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });

  const testPath = join(dirPath, `.write-test-${Date.now()}-${Math.random()}`);
  await writeFile(testPath, "ok", "utf8");
  await rm(testPath, { force: true });
}

export async function backupRustfsToUploads(): Promise<number> {
  const SOURCE_DIR =
    process.env.RUSTFS_BACKUP_SOURCE || join("rustfs-data", "audiostream");
  const DESTINATION_DIR = process.env.RUSTFS_BACKUP_DEST || "uploads";
  const DRY_RUN = parseBoolean(process.env.RUSTFS_BACKUP_DRY_RUN, true);
  const OVERWRITE = parseBoolean(process.env.RUSTFS_BACKUP_OVERWRITE, false);
  const KEEP_CONFLICT_COPY = parseBoolean(
    process.env.RUSTFS_BACKUP_KEEP_CONFLICT_COPY,
    false,
  );
  const VERIFY_HASH = parseBoolean(process.env.RUSTFS_BACKUP_VERIFY_HASH, true);
  const MAX_FAILURES = parseNonNegativeInt(
    process.env.RUSTFS_BACKUP_MAX_FAILURES,
    0,
  );
  const MAX_CONFLICTS = parseNonNegativeInt(
    process.env.RUSTFS_BACKUP_MAX_CONFLICTS,
    0,
  );

  const report: BackupReport = {
    startedAt: new Date().toISOString(),
    sourceDir: SOURCE_DIR,
    destinationDir: DESTINATION_DIR,
    dryRun: DRY_RUN,
    overwrite: OVERWRITE,
    keepConflictCopy: KEEP_CONFLICT_COPY,
    verifyHash: VERIFY_HASH,
    maxFailures: MAX_FAILURES,
    maxConflicts: MAX_CONFLICTS,
    summary: {
      discovered: 0,
      copied: 0,
      skipped: 0,
      conflicts: 0,
      failed: 0,
      dryRun: 0,
      copiedBytes: 0,
    },
    objects: [],
  };

  await logger.info("Starting RustFS filesystem backup", {
    context: CONTEXT,
  });
  await logger.info(
    `Configuration: source=${SOURCE_DIR}, destination=${DESTINATION_DIR}, dryRun=${DRY_RUN}, overwrite=${OVERWRITE}, keepConflictCopy=${KEEP_CONFLICT_COPY}, verifyHash=${VERIFY_HASH}`,
    { context: CONTEXT },
  );

  try {
    if (!existsSync(SOURCE_DIR)) {
      throw new Error(`Source directory not found: ${SOURCE_DIR}`);
    }

    await ensureWritableDirectory(DESTINATION_DIR);

    const objectDirs = await findObjectDirs(SOURCE_DIR);
    report.summary.discovered = objectDirs.length;

    await logger.info(`Discovered ${objectDirs.length} object directories`, {
      context: CONTEXT,
    });

    for (let index = 0; index < objectDirs.length; index += 1) {
      const objectDir = objectDirs[index];
      const key = toPosixPath(relative(SOURCE_DIR, objectDir));
      const destinationPath = buildDestinationPath(DESTINATION_DIR, key);

      const result: ObjectResult = {
        key,
        status: "failed",
        objectDir,
        destinationPath,
        partCount: 0,
        expectedBytes: 0,
      };

      try {
        const candidates = await collectSegmentCandidates(objectDir);

        if (candidates.length === 0) {
          result.status = "failed";
          result.reason = "No segment directories with part.N files";
          report.summary.failed += 1;
          report.objects.push(result);
          continue;
        }

        const selected = candidates[0];
        result.segmentDir = selected.dirPath;
        result.partCount = selected.parts.length;
        result.expectedBytes = selected.totalBytes;

        if (candidates.length > 1) {
          await logger.warn(
            `Multiple segment directories found for ${key}; selected ${toPosixPath(relative(objectDir, selected.dirPath))}`,
            { context: CONTEXT },
          );
        }

        const missingParts = findMissingParts(selected.parts);
        if (missingParts.length > 0) {
          result.status = "failed";
          result.reason = `Missing part numbers: ${missingParts.join(", ")}`;
          report.summary.failed += 1;
          report.objects.push(result);
          continue;
        }

        let sourceSha: string | undefined;
        const resolveSourceHash = async () => {
          if (!sourceSha) {
            sourceSha = await hashParts(selected.parts);
          }
          return sourceSha;
        };

        const destinationExists = existsSync(destinationPath);

        if (destinationExists) {
          const destinationStats = await stat(destinationPath);

          let matches = destinationStats.size === selected.totalBytes;
          if (matches && VERIFY_HASH) {
            const [expectedHash, destinationHash] = await Promise.all([
              resolveSourceHash(),
              hashFile(destinationPath),
            ]);
            matches = expectedHash === destinationHash;
            result.sourceSha256 = expectedHash;
            result.destinationSha256 = destinationHash;
          }

          if (matches) {
            result.status = "skipped";
            result.reason = "Destination exists and already matches";
            result.writtenBytes = destinationStats.size;
            report.summary.skipped += 1;
            report.objects.push(result);
            continue;
          }

          if (!OVERWRITE && !KEEP_CONFLICT_COPY) {
            result.status = "conflict";
            result.reason =
              "Destination exists but differs; rerun with RUSTFS_BACKUP_OVERWRITE=true or RUSTFS_BACKUP_KEEP_CONFLICT_COPY=true";
            result.writtenBytes = destinationStats.size;
            report.summary.conflicts += 1;
            report.objects.push(result);
            continue;
          }
        }

        let finalDestinationPath = destinationPath;
        if (destinationExists && !OVERWRITE && KEEP_CONFLICT_COPY) {
          finalDestinationPath = `${destinationPath}.rustfs-backup-conflict-${Date.now()}`;
          result.destinationPath = finalDestinationPath;
        }

        if (DRY_RUN) {
          result.status = "dry-run";
          result.reason =
            destinationExists && OVERWRITE
              ? "Would overwrite destination"
              : destinationExists && KEEP_CONFLICT_COPY
                ? "Would write conflict copy"
                : "Would create destination";
          report.summary.dryRun += 1;
          report.objects.push(result);
          continue;
        }

        const writtenBytes = await writeReconstructedFile(
          selected.parts,
          finalDestinationPath,
        );

        result.writtenBytes = writtenBytes;

        if (writtenBytes !== selected.totalBytes) {
          result.status = "failed";
          result.reason = `Size mismatch after write: expected ${selected.totalBytes}, got ${writtenBytes}`;
          report.summary.failed += 1;
          report.objects.push(result);
          continue;
        }

        if (VERIFY_HASH) {
          const [expectedHash, destinationHash] = await Promise.all([
            resolveSourceHash(),
            hashFile(finalDestinationPath),
          ]);

          result.sourceSha256 = expectedHash;
          result.destinationSha256 = destinationHash;

          if (expectedHash !== destinationHash) {
            result.status = "failed";
            result.reason = "SHA-256 mismatch after write";
            report.summary.failed += 1;
            report.objects.push(result);
            continue;
          }
        }

        result.status = "copied";
        result.reason =
          destinationExists && OVERWRITE
            ? "Destination overwritten"
            : destinationExists && KEEP_CONFLICT_COPY
              ? "Conflict copy created"
              : "Copied successfully";
        report.summary.copied += 1;
        report.summary.copiedBytes += writtenBytes;
        report.objects.push(result);
      } catch (error) {
        result.status = "failed";
        result.reason = error instanceof Error ? error.message : String(error);
        report.summary.failed += 1;
        report.objects.push(result);
      }

      if ((index + 1) % 50 === 0 || index + 1 === objectDirs.length) {
        await logger.info(
          `Progress ${index + 1}/${objectDirs.length}: copied=${report.summary.copied}, skipped=${report.summary.skipped}, conflicts=${report.summary.conflicts}, failed=${report.summary.failed}, dryRun=${report.summary.dryRun}`,
          { context: CONTEXT },
        );
      }
    }
  } catch (error) {
    await logger.error("RustFS backup failed during preflight", error, {
      context: CONTEXT,
    });
    report.summary.failed += 1;
  }

  report.finishedAt = new Date().toISOString();

  const reportDate = sanitizeTimestampForFile(new Date(report.startedAt));
  const reportPath = join("logs", `rustfs-backup-${reportDate}.json`);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");

  const shouldFailByThreshold =
    report.summary.failed > report.maxFailures ||
    report.summary.conflicts > report.maxConflicts;

  await logger.info(
    `Backup summary: discovered=${report.summary.discovered}, copied=${report.summary.copied}, skipped=${report.summary.skipped}, conflicts=${report.summary.conflicts}, failed=${report.summary.failed}, dryRun=${report.summary.dryRun}, copiedBytes=${report.summary.copiedBytes}`,
    { context: CONTEXT },
  );
  await logger.info(`Report written: ${toPosixPath(reportPath)}`, {
    context: CONTEXT,
  });

  if (shouldFailByThreshold) {
    await logger.error(
      `Threshold exceeded (failures>${report.maxFailures} or conflicts>${report.maxConflicts})`,
      undefined,
      {
        context: CONTEXT,
      },
    );
    return 1;
  }

  await logger.info("RustFS backup completed", { context: CONTEXT });
  return 0;
}

if (import.meta.main) {
  try {
    const exitCode = await backupRustfsToUploads();
    process.exit(exitCode);
  } catch (error) {
    await logger.error("RustFS backup encountered an unexpected error", error, {
      context: CONTEXT,
    });
    process.exit(1);
  }
}

export default backupRustfsToUploads;
