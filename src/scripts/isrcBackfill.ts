import { mkdir } from "fs/promises";
import type { AudioFile } from "../db/schema";
import { AudioRepository } from "../db/repositories";
import { TEMP_DIR } from "../utils/helpers";
import { getIsrcFromDeezerSearch } from "../utils/deezer";
import { getTidalTrackIsrc } from "../utils/tidal";
import { NO_ISRC_SENTINEL, normalizeIsrc } from "../utils/isrc";
import { logger } from "../utils/logger";
import { Storage } from "../utils/storage";

const CONTEXT = "BACKFILL";
const SNAPSHOT_PAGE_SIZE = 500;
const MAX_TRACKS = 10;

function parseTidalTrackId(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function isMissingIsrc(audio: AudioFile): boolean {
  const normalized = normalizeIsrc(audio.isrc);
  if (!normalized) {
    return true;
  }

  return normalized === NO_ISRC_SENTINEL;
}

async function snapshotCandidateAudios(): Promise<AudioFile[]> {
  const allFiles: AudioFile[] = [];
  let page = 1;
  let total = Number.POSITIVE_INFINITY;

  while (allFiles.length < total) {
    const { files, total: currentTotal } = await AudioRepository.findAll({
      page,
      limit: SNAPSHOT_PAGE_SIZE,
      sortBy: "uploadedAt",
      sortOrder: "asc",
    });

    total = currentTotal;
    if (files.length === 0) {
      break;
    }

    allFiles.push(...files);
    page++;
  }

  const candidates = allFiles.filter(isMissingIsrc);

  if (MAX_TRACKS > 0) {
    return candidates.slice(0, MAX_TRACKS);
  }

  return candidates;
}

async function main() {
  await mkdir(TEMP_DIR, { recursive: true });
  await Storage.init();

  const stats = {
    candidates: 0,
    processed: 0,
    updated: 0,
    failed: 0,
    fromTidal: 0,
    fromDeezer: 0,
    markedSentinel: 0,
  };

  try {
    const candidateAudios = await snapshotCandidateAudios();
    stats.candidates = candidateAudios.length;

    logger.info(`ISRC backfill starting. candidates=${stats.candidates}`, {
      context: CONTEXT,
    });

    for (const audio of candidateAudios) {
      stats.processed++;

      try {
        const currentIsrc = normalizeIsrc(audio.isrc);
        if (currentIsrc && currentIsrc !== NO_ISRC_SENTINEL) {
          continue;
        }

        let resolvedIsrc: string | null = null;

        const tidalTrackId = parseTidalTrackId(audio.tidalId);
        if (tidalTrackId) {
          resolvedIsrc = await getTidalTrackIsrc(tidalTrackId);
          if (resolvedIsrc) {
            stats.fromTidal++;
          }
        }

        if (!resolvedIsrc) {
          resolvedIsrc = await getIsrcFromDeezerSearch({
            title: audio.title,
            artist: audio.artist,
          });

          if (resolvedIsrc) {
            stats.fromDeezer++;
          }
        }

        if (resolvedIsrc) {
          await AudioRepository.update(audio.id, { isrc: resolvedIsrc });
          stats.updated++;
          continue;
        }

        await AudioRepository.update(audio.id, { isrc: NO_ISRC_SENTINEL });
        stats.markedSentinel++;
      } catch (error) {
        stats.failed++;
        logger.error(`ISRC backfill failed for ${audio.id}`, error, {
          context: CONTEXT,
        });
      }
    }

    logger.info(
      `ISRC backfill finished. candidates=${stats.candidates}, processed=${stats.processed}, updated=${stats.updated}, markedSentinel=${stats.markedSentinel}, failed=${stats.failed}, sourceTidal=${stats.fromTidal}, sourceDeezer=${stats.fromDeezer}`,
      { context: CONTEXT },
    );
  } catch (error) {
    logger.error("ISRC backfill failed", error, { context: CONTEXT });
  }
}

main().catch(async (error) => {
  logger.error("ISRC backfill crashed", error, { context: CONTEXT });
  process.exit(1);
});

export default main;
