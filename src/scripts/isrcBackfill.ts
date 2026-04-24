import { mkdir } from "fs/promises";
import { existsSync, unlinkSync } from "fs";
import { join } from "path";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { db, closeDb } from "../db";
import { audioFiles } from "../db/schema";
import { AudioRepository } from "../db/repositories";
import { AudioService } from "../modules/audio/service";
import { TEMP_DIR } from "../utils/helpers";
import { getIsrcFromDeezerSearch } from "../utils/deezer";
import { getTidalTrackIsrc } from "../utils/tidal";
import { NO_ISRC_SENTINEL, normalizeIsrc } from "../utils/isrc";
import { logger } from "../utils/logger";
import { Storage } from "../utils/storage";

const CONTEXT = "ISRC_BACKFILL";
const SNAPSHOT_PAGE_SIZE = 500;
const MAX_TRACKS = 10;
const FETCH_FILE_METADATA = true;
const MARK_UNRESOLVED_WITH_SENTINEL = true;
const INCLUDE_NO_ISRC_SENTINEL = true;

function parseTidalTrackId(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

async function snapshotCandidateIds(): Promise<string[]> {
  const ids: string[] = [];
  let page = 0;

  const isrcMissingCondition = INCLUDE_NO_ISRC_SENTINEL
    ? or(
        isNull(audioFiles.isrc),
        eq(audioFiles.isrc, ""),
        eq(audioFiles.isrc, NO_ISRC_SENTINEL),
      )
    : or(isNull(audioFiles.isrc), eq(audioFiles.isrc, ""));

  while (true) {
    const rows = await db
      .select({ id: audioFiles.id })
      .from(audioFiles)
      .where(and(isNull(audioFiles.deletedAt), isrcMissingCondition))
      .orderBy(asc(audioFiles.uploadedAt), asc(audioFiles.id))
      .limit(SNAPSHOT_PAGE_SIZE)
      .offset(page * SNAPSHOT_PAGE_SIZE);

    if (rows.length === 0) break;

    for (const row of rows) {
      ids.push(row.id);
      if (MAX_TRACKS > 0 && ids.length >= MAX_TRACKS) {
        return ids;
      }
    }

    page++;
  }

  return ids;
}

async function resolveFromFileMetadata(audio: {
  id: string;
  filename: string;
  title: string | null;
  artist: string | null;
}): Promise<string | null> {
  const tempPath = join(TEMP_DIR, `isrc_${audio.id}_${audio.filename}`);

  try {
    const data = await Storage.download(audio.filename);
    await Bun.write(tempPath, data);

    const extracted = await AudioService.extractMetadata(tempPath);
    const metadataIsrc = normalizeIsrc(extracted?.isrc);
    if (metadataIsrc) return metadataIsrc;

    const betterTitle = extracted?.title ?? audio.title;
    const betterArtist = extracted?.artist ?? audio.artist;

    const deezerIsrc = await getIsrcFromDeezerSearch({
      title: betterTitle,
      artist: betterArtist,
    });
    if (deezerIsrc) return deezerIsrc;

    return null;
  } finally {
    if (existsSync(tempPath)) {
      try {
        unlinkSync(tempPath);
      } catch {}
    }
  }
}

async function main() {
  await mkdir(TEMP_DIR, { recursive: true });
  await Storage.init();

  const stats = {
    candidates: 0,
    processed: 0,
    updated: 0,
    unresolved: 0,
    failed: 0,
    fromTidal: 0,
    fromDeezer: 0,
    fromSpotify: 0,
    fromFileMetadata: 0,
    markedSentinel: 0,
  };

  try {
    const candidateIds = await snapshotCandidateIds();
    stats.candidates = candidateIds.length;

    logger.info(
      `ISRC backfill starting. candidates=${stats.candidates}, fetchFileMetadata=${FETCH_FILE_METADATA}, includeSentinel=${INCLUDE_NO_ISRC_SENTINEL}, markUnresolved=${MARK_UNRESOLVED_WITH_SENTINEL}`,
      { context: CONTEXT },
    );

    for (const id of candidateIds) {
      stats.processed++;

      try {
        const audio = await AudioRepository.findById(id);
        if (!audio) {
          continue;
        }

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

        if (!resolvedIsrc && FETCH_FILE_METADATA) {
          resolvedIsrc = await resolveFromFileMetadata({
            id: audio.id,
            filename: audio.filename,
            title: audio.title,
            artist: audio.artist,
          });

          if (resolvedIsrc) {
            stats.fromFileMetadata++;
          }
        }

        if (resolvedIsrc) {
          await AudioRepository.update(audio.id, { isrc: resolvedIsrc });
          stats.updated++;
          continue;
        }

        if (MARK_UNRESOLVED_WITH_SENTINEL) {
          await AudioRepository.update(audio.id, { isrc: NO_ISRC_SENTINEL });
          stats.markedSentinel++;
          continue;
        }

        stats.unresolved++;
      } catch (error) {
        stats.failed++;
        logger.error(`ISRC backfill failed for ${id}`, error, {
          context: CONTEXT,
        });
      }
    }

    logger.info(
      `ISRC backfill finished. candidates=${stats.candidates}, processed=${stats.processed}, updated=${stats.updated}, unresolved=${stats.unresolved}, markedSentinel=${stats.markedSentinel}, failed=${stats.failed}, sourceTidal=${stats.fromTidal}, sourceDeezer=${stats.fromDeezer}, sourceSpotify=${stats.fromSpotify}, sourceFileMetadata=${stats.fromFileMetadata}`,
      { context: CONTEXT },
    );
  } finally {
    await closeDb();
  }
}

main().catch(async (error) => {
  logger.error("ISRC backfill crashed", error, { context: CONTEXT });
  await closeDb();
  process.exit(1);
});

export default main;
