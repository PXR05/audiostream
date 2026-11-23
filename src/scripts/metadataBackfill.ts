import { existsSync, unlinkSync } from "fs";
import { mkdir } from "fs/promises";
import { join } from "path";
import type { AudioFile, NewAudioFile } from "../db/schema";
import { AudioRepository } from "../db/repositories";
import { processAndStoreCoverArt } from "../utils/coverArt";
import { TEMP_DIR } from "../utils/helpers";
import { logger } from "../utils/logger";
import {
  extractAndStoreCoverArt,
  extractAudioMetadata,
  resolveArtistList,
  serializeExtraMetadata,
} from "../utils/metadata";
import { Storage } from "../utils/storage";

const CONTEXT = "METADATA_BACKFILL";
const LEGACY_FORMATS = new Set(["MPEG", "Ogg", "MPEG-4", "WAVE"]);

interface CliOptions {
  all: boolean;
  covers: boolean;
  missingCovers: boolean;
  upgradeCovers: boolean;
  dryRun: boolean;
  concurrency: number;
  limit: number | null;
}

function parseCliArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    all: false,
    covers: false,
    missingCovers: false,
    upgradeCovers: false,
    dryRun: false,
    concurrency: 4,
    limit: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--all") {
      opts.all = true;
    } else if (arg === "--covers") {
      opts.covers = true;
    } else if (arg === "--missing-covers") {
      opts.missingCovers = true;
    } else if (arg === "--upgrade-covers") {
      opts.upgradeCovers = true;
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--concurrency" && argv[i + 1]) {
      const parsed = Number.parseInt(argv[++i], 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        opts.concurrency = Math.min(parsed, 16);
      }
    } else if (arg === "--limit" && argv[i + 1]) {
      const parsed = Number.parseInt(argv[++i], 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        opts.limit = parsed;
      }
    }
  }

  return opts;
}

function normalizeYoutubeArtistCommas(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const normalized = value
    .replace(/,\s*/g, "; ")
    .replace(/\s*;\s*/g, "; ")
    .replace(/^(?:;\s*)+|(?:;\s*)+$/g, "")
    .trim();
  return normalized.length > 0 ? normalized : null;
}

function isLegacyCoverKey(imageFile: string | null): boolean {
  return Boolean(imageFile && !imageFile.startsWith("cover_"));
}

function needsCoverProcessing(file: AudioFile, opts: CliOptions): boolean {
  if (opts.covers) return true;
  if (opts.missingCovers && !file.imageFile) return true;
  if (opts.upgradeCovers && isLegacyCoverKey(file.imageFile)) return true;
  return false;
}

function needsBackfill(file: AudioFile, opts: CliOptions): boolean {
  if (opts.all) return true;
  if (needsCoverProcessing(file, opts)) return true;

  if (file.format && LEGACY_FORMATS.has(file.format)) return true;

  if (
    file.youtubeId &&
    (file.artist?.includes(",") || file.albumArtist?.includes(","))
  ) {
    return true;
  }

  return (
    file.codec === null ||
    file.duration === null ||
    file.bitrate === null ||
    file.sampleRate === null ||
    (file.artist !== null && (!file.artists || file.artists.length === 0))
  );
}

async function snapshotCandidateFiles(opts: CliOptions): Promise<AudioFile[]> {
  const allFiles: AudioFile[] = [];
  let page = 1;
  let total = Number.POSITIVE_INFINITY;

  while (allFiles.length < total) {
    const { files, total: currentTotal } = await AudioRepository.findAll({
      page,
      limit: 100,
      sortBy: "id",
      sortOrder: "asc",
    });

    total = currentTotal;
    if (files.length === 0) break;

    allFiles.push(...files);
    page++;
  }

  const filtered = allFiles.filter((file) => needsBackfill(file, opts));
  return opts.limit ? filtered.slice(0, opts.limit) : filtered;
}

function buildSafePatch(
  existing: AudioFile,
  extracted: NonNullable<Awaited<ReturnType<typeof extractAudioMetadata>>>,
): Partial<NewAudioFile> {
  const patch = AudioRepository.toMetadataPatch(
    extracted.metadata,
    serializeExtraMetadata(extracted.extra),
  );

  patch.title = patch.title ?? existing.title;
  patch.artist = patch.artist ?? existing.artist;
  patch.albumArtist = patch.albumArtist ?? existing.albumArtist;
  patch.album = patch.album ?? existing.album;
  patch.year = patch.year ?? existing.year;
  patch.genre = patch.genre ?? existing.genre;
  patch.duration = patch.duration ?? existing.duration;
  patch.bitrate = patch.bitrate ?? existing.bitrate;
  patch.sampleRate = patch.sampleRate ?? existing.sampleRate;
  patch.channels = patch.channels ?? existing.channels;
  patch.format = patch.format ?? existing.format;

  if ((!patch.bitDepth || patch.bitDepth === 0) && existing.bitDepth > 0) {
    patch.bitDepth = existing.bitDepth;
  }
  if (extracted.metadata.isrc && !existing.isrc) {
    patch.isrc = extracted.metadata.isrc;
  }

  if (existing.extra || patch.extra) {
    const mergedExtra = {
      ...(existing.extra ?? {}),
      ...(patch.extra ?? {}),
    };
    patch.extra = Object.keys(mergedExtra).length > 0 ? mergedExtra : null;
  }

  if (existing.youtubeId) {
    let normalizedArtist = normalizeYoutubeArtistCommas(patch.artist);
    const normalizedAlbumArtist = normalizeYoutubeArtistCommas(
      patch.albumArtist,
    );

    if (
      normalizedAlbumArtist &&
      normalizedAlbumArtist.includes(";") &&
      (!normalizedArtist ||
        (!normalizedArtist.includes(";") &&
          normalizedAlbumArtist
            .toLowerCase()
            .startsWith(`${normalizedArtist.toLowerCase()};`)))
    ) {
      normalizedArtist = normalizedAlbumArtist;
    }

    patch.artist = normalizedArtist;
    patch.albumArtist = normalizedAlbumArtist ?? normalizedArtist;

    const rawYoutubeArtists = [
      ...(patch.artists ?? []),
      ...(normalizedArtist ? [normalizedArtist] : []),
      ...(normalizedAlbumArtist ? [normalizedAlbumArtist] : []),
    ];
    const normalizedArtists = [
      ...new Set(
        rawYoutubeArtists.flatMap((entry) => {
          const normalized = normalizeYoutubeArtistCommas(entry);
          return normalized ? resolveArtistList([], normalized) : [];
        }),
      ),
    ];
    patch.artists = normalizedArtists.length > 0 ? normalizedArtists : null;
  } else if ((!patch.artists || patch.artists.length === 0) && patch.artist) {
    const derived = resolveArtistList([], patch.artist);
    if (derived.length > 0) {
      patch.artists = derived;
    }
  }

  return patch;
}

async function resolveBackfillCover(
  file: AudioFile,
  tempAudioPath: string,
  extractedPictures: NonNullable<
    Awaited<ReturnType<typeof extractAudioMetadata>>
  >["pictures"],
): Promise<string | null> {
  const fromAudio = await extractAndStoreCoverArt(
    tempAudioPath,
    extractedPictures,
  );
  if (fromAudio) return fromAudio;

  if (file.imageFile && isLegacyCoverKey(file.imageFile)) {
    try {
      if (await Storage.exists(file.imageFile)) {
        const legacyBytes = await Storage.download(file.imageFile);
        return await processAndStoreCoverArt(legacyBytes);
      }
    } catch (error) {
      logger.warn(
        `Failed to upgrade legacy cover ${file.imageFile} for ${file.id}: ${error instanceof Error ? error.message : String(error)}`,
        { context: CONTEXT },
      );
    }
  }

  return null;
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const current = nextIndex++;
        if (current >= items.length) return;
        await worker(items[current], current);
      }
    },
  );
  await Promise.all(runners);
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  await mkdir(TEMP_DIR, { recursive: true });
  await Storage.init();

  const stats = {
    total: 0,
    processed: 0,
    updated: 0,
    coversUpdated: 0,
    youtubeArtistsNormalized: 0,
    skipped: 0,
    failed: 0,
  };

  const candidates = await snapshotCandidateFiles(opts);
  stats.total = candidates.length;

  logger.info(
    `Metadata backfill starting. total=${stats.total}, concurrency=${opts.concurrency}, all=${opts.all}, covers=${opts.covers}, missingCovers=${opts.missingCovers}, upgradeCovers=${opts.upgradeCovers}, dryRun=${opts.dryRun}`,
    { context: CONTEXT },
  );

  if (candidates.length === 0) {
    logger.info("No files need metadata backfill.", { context: CONTEXT });
    return;
  }

  const startedAt = performance.now();

  await runPool(candidates, opts.concurrency, async (file, index) => {
    const tempPath = join(TEMP_DIR, `backfill_${file.id}_${file.filename}`);

    try {
      if (!(await Storage.exists(file.filename))) {
        stats.skipped++;
        logger.warn(
          `Skipping ${file.id}: missing in storage (${file.filename})`,
          { context: CONTEXT },
        );
        return;
      }

      const data = await Storage.download(file.filename);
      await Bun.write(tempPath, data);

      const shouldProcessCover = needsCoverProcessing(file, opts);

      const extracted = await extractAudioMetadata(tempPath, {
        includeCover: shouldProcessCover,
      });

      if (!extracted) {
        stats.failed++;
        logger.warn(`No metadata extracted for ${file.id} (${file.filename})`, {
          context: CONTEXT,
        });
        return;
      }

      const patch = buildSafePatch(file, extracted);

      if (
        file.youtubeId &&
        (patch.artist !== file.artist ||
          patch.albumArtist !== file.albumArtist ||
          file.artist?.includes(",") ||
          file.albumArtist?.includes(","))
      ) {
        stats.youtubeArtistsNormalized++;
      }

      if (shouldProcessCover && !opts.dryRun) {
        const coverKey = await resolveBackfillCover(
          file,
          tempPath,
          extracted.pictures,
        );
        if (coverKey && coverKey !== file.imageFile) {
          patch.imageFile = coverKey;
          stats.coversUpdated++;
        }
      } else if (shouldProcessCover && opts.dryRun) {
        if (extracted.pictures.length > 0 || isLegacyCoverKey(file.imageFile)) {
          stats.coversUpdated++;
        }
      }

      if (opts.dryRun) {
        logger.info(
          `[DRY-RUN] ${file.id} (${file.filename}): title=${JSON.stringify(patch.title)} artist=${JSON.stringify(patch.artist)} albumArtist=${JSON.stringify(patch.albumArtist)} artists=${JSON.stringify(patch.artists)} format=${patch.format} codec=${patch.codec} lossless=${patch.lossless}`,
          { context: CONTEXT },
        );
      } else {
        await AudioRepository.update(file.id, patch);
      }

      stats.updated++;
      if ((index + 1) % 25 === 0 || index + 1 === stats.total) {
        logger.info(
          `Progress: ${index + 1}/${stats.total} (updated=${stats.updated}, covers=${stats.coversUpdated}, ytArtists=${stats.youtubeArtistsNormalized}, skipped=${stats.skipped}, failed=${stats.failed})`,
          { context: CONTEXT },
        );
      }
    } catch (error) {
      stats.failed++;
      logger.error(`Metadata backfill failed for ${file.id}`, error, {
        context: CONTEXT,
      });
    } finally {
      stats.processed++;
      if (existsSync(tempPath)) {
        try {
          unlinkSync(tempPath);
        } catch {}
      }
    }
  });

  const elapsedSec = ((performance.now() - startedAt) / 1000).toFixed(2);
  logger.info(
    `Metadata backfill finished in ${elapsedSec}s. total=${stats.total}, processed=${stats.processed}, updated=${stats.updated}, coversUpdated=${stats.coversUpdated}, youtubeArtistsNormalized=${stats.youtubeArtistsNormalized}, skipped=${stats.skipped}, failed=${stats.failed}`,
    { context: CONTEXT },
  );
}

main().catch((error) => {
  logger.error("Metadata backfill crashed", error, { context: CONTEXT });
  process.exit(1);
});

export default main;
