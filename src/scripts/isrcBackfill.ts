import type { AudioFile } from "../db/schema";
import { AudioRepository } from "../db/repositories";
import { getIsrcFromDeezerSearch } from "../utils/deezer";
import { getIsrcFromMusicBrainzSearch } from "../utils/musicbrainz";
import { getTidalTrackIsrc } from "../utils/tidal";
import { NO_ISRC_SENTINEL, normalizeIsrc } from "../utils/isrc";
import { logger } from "../utils/logger";

const CONTEXT = "ISRC_BACKFILL";

export interface IsrcBackfillOptions {
  retrySentinel: boolean;
  dryRun: boolean;
  concurrency: number;
  limit: number | null;
}

const DEFAULT_OPTIONS: IsrcBackfillOptions = {
  retrySentinel: false,
  dryRun: false,
  concurrency: 4,
  limit: null,
};

function parseCliArgs(argv: string[]): IsrcBackfillOptions {
  const opts: IsrcBackfillOptions = { ...DEFAULT_OPTIONS };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--retry-sentinel") {
      opts.retrySentinel = true;
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--concurrency" && argv[i + 1]) {
      const parsed = Number.parseInt(argv[++i], 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        opts.concurrency = Math.min(parsed, 10);
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

function parseTidalTrackId(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function isCandidateForIsrc(
  audio: AudioFile,
  retrySentinel: boolean,
): boolean {
  const normalized = normalizeIsrc(audio.isrc);
  if (!normalized) return true;
  return retrySentinel && normalized === NO_ISRC_SENTINEL;
}

async function snapshotCandidateAudios(
  opts: IsrcBackfillOptions,
): Promise<AudioFile[]> {
  const allFiles: AudioFile[] = [];
  let page = 1;
  let total = Number.POSITIVE_INFINITY;

  while (allFiles.length < total) {
    const { files, total: currentTotal } = await AudioRepository.findAll({
      page,
      limit: 100,
      sortBy: "uploadedAt",
      sortOrder: "asc",
    });

    total = currentTotal;
    if (files.length === 0) break;

    allFiles.push(...files);
    page++;
  }

  const candidates = allFiles.filter((file) =>
    isCandidateForIsrc(file, opts.retrySentinel),
  );
  return opts.limit ? candidates.slice(0, opts.limit) : candidates;
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

export async function runIsrcBackfill(
  options: Partial<IsrcBackfillOptions> = {},
): Promise<void> {
  const opts: IsrcBackfillOptions = { ...DEFAULT_OPTIONS, ...options };

  const stats = {
    candidates: 0,
    processed: 0,
    updated: 0,
    failed: 0,
    fromTidal: 0,
    fromDeezer: 0,
    fromMusicBrainz: 0,
    markedSentinel: 0,
  };

  const candidateAudios = await snapshotCandidateAudios(opts);
  stats.candidates = candidateAudios.length;

  logger.info(
    `ISRC backfill starting. candidates=${stats.candidates}, concurrency=${opts.concurrency}, retrySentinel=${opts.retrySentinel}, dryRun=${opts.dryRun}`,
    { context: CONTEXT },
  );

  if (candidateAudios.length === 0) {
    logger.info("No files need ISRC backfill.", { context: CONTEXT });
    return;
  }

  const startedAt = performance.now();

  await runPool(candidateAudios, opts.concurrency, async (audio, index) => {
    try {
      const currentIsrc = normalizeIsrc(audio.isrc);
      if (currentIsrc && currentIsrc !== NO_ISRC_SENTINEL) {
        return;
      }

      let resolvedIsrc: string | null = null;
      let source: "tidal" | "deezer" | "musicbrainz" | null = null;

      const tidalTrackId = parseTidalTrackId(audio.tidalId);
      if (tidalTrackId) {
        resolvedIsrc = await getTidalTrackIsrc(tidalTrackId);
        if (resolvedIsrc) {
          source = "tidal";
          stats.fromTidal++;
        }
      }

      if (!resolvedIsrc) {
        resolvedIsrc = await getIsrcFromDeezerSearch({
          title: audio.title,
          artist: audio.artist,
          artists: audio.artists,
          album: audio.album,
          duration: audio.duration,
        });
        if (resolvedIsrc) {
          source = "deezer";
          stats.fromDeezer++;
        }
      }

      if (!resolvedIsrc) {
        resolvedIsrc = await getIsrcFromMusicBrainzSearch({
          title: audio.title,
          artist: audio.artist,
          artists: audio.artists,
          album: audio.album,
          duration: audio.duration,
        });
        if (resolvedIsrc) {
          source = "musicbrainz";
          stats.fromMusicBrainz++;
        }
      }

      if (resolvedIsrc) {
        if (opts.dryRun) {
          logger.info(
            `[DRY-RUN] ${audio.id} (${audio.title} - ${audio.artist}): ${resolvedIsrc} via ${source}`,
            { context: CONTEXT },
          );
        } else {
          await AudioRepository.update(audio.id, { isrc: resolvedIsrc });
        }
        stats.updated++;
      } else {
        if (!opts.dryRun && currentIsrc !== NO_ISRC_SENTINEL) {
          await AudioRepository.update(audio.id, { isrc: NO_ISRC_SENTINEL });
        }
        stats.markedSentinel++;
      }

      if ((index + 1) % 25 === 0 || index + 1 === stats.candidates) {
        logger.info(
          `Progress: ${index + 1}/${stats.candidates} (updated=${stats.updated}, tidal=${stats.fromTidal}, deezer=${stats.fromDeezer}, mb=${stats.fromMusicBrainz}, sentinel=${stats.markedSentinel}, failed=${stats.failed})`,
          { context: CONTEXT },
        );
      }
    } catch (error) {
      stats.failed++;
      logger.error(`ISRC backfill failed for ${audio.id}`, error, {
        context: CONTEXT,
      });
    } finally {
      stats.processed++;
    }
  });

  const elapsedSec = ((performance.now() - startedAt) / 1000).toFixed(2);
  logger.info(
    `ISRC backfill finished in ${elapsedSec}s. candidates=${stats.candidates}, processed=${stats.processed}, updated=${stats.updated}, markedSentinel=${stats.markedSentinel}, failed=${stats.failed}, sourceTidal=${stats.fromTidal}, sourceDeezer=${stats.fromDeezer}, sourceMusicBrainz=${stats.fromMusicBrainz}`,
    { context: CONTEXT },
  );
}

if (import.meta.main) {
  runIsrcBackfill(parseCliArgs(process.argv.slice(2))).catch((error) => {
    logger.error("ISRC backfill crashed", error, { context: CONTEXT });
    process.exit(1);
  });
}

export default runIsrcBackfill;
