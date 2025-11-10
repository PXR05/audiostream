import { AudioRepository } from "../db/repositories";
import { PlaylistService } from "../modules/playlist/service";
import { logger } from "../utils/logger";

async function migrateExistingTracksToPlaylists() {
  logger.info("Starting playlist migration for existing tracks...", {
    context: "MIGRATION",
  });

  const { files: allTracks, total } = await AudioRepository.findAll({
    page: 1,
    limit: 999999,
    sortBy: "uploadedAt",
    sortOrder: "asc",
  });

  logger.info(`Found ${total} tracks to process`, { context: "MIGRATION" });

  let processed = 0;
  let skipped = 0;
  let artistPlaylists = 0;
  let albumPlaylists = 0;

  for (const track of allTracks) {
    try {
      const hasArtist = track.artist && track.artist.trim() !== "";
      const hasAlbum = track.album && track.album.trim() !== "";

      if (!hasArtist && !hasAlbum) {
        logger.info(
          `Skipping track ${track.id} - no artist or album metadata`,
          {
            context: "MIGRATION",
          },
        );
        skipped++;
        continue;
      }

      logger.info(
        `Processing track ${track.id}: ${track.title || track.filename}`,
        { context: "MIGRATION" },
      );

      await PlaylistService.addTrackToAutoPlaylists(
        track.id,
        hasArtist ? track.artist! : undefined,
        hasAlbum ? track.album! : undefined,
      );

      if (hasArtist) artistPlaylists++;
      if (hasAlbum) albumPlaylists++;

      processed++;
      logger.info(`Progress: ${processed}/${total} tracks processed`, {
        context: "MIGRATION",
      });
    } catch (error) {
      logger.error(
        `Failed to process track ${track.id}`,
        error instanceof Error ? error : new Error(String(error)),
        { context: "MIGRATION" },
      );
    }
  }

  logger.info(
    `Migration completed! Processed: ${processed}, Skipped: ${skipped}`,
    { context: "MIGRATION" },
  );
  logger.info(
    `Artist playlists updated: ${artistPlaylists}, Album playlists updated: ${albumPlaylists}`,
    { context: "MIGRATION" },
  );
}

migrateExistingTracksToPlaylists()
  .then(() => {
    logger.info("Migration script finished successfully", {
      context: "MIGRATION",
    });
    process.exit(0);
  })
  .catch((error) => {
    logger.error(
      "Migration script failed",
      error instanceof Error ? error : new Error(String(error)),
      { context: "MIGRATION" },
    );
    process.exit(1);
  });
