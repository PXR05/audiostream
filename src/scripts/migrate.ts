import {
  AudioRepository,
  UserRepository,
  PlaylistRepository,
} from "../db/repositories";
import { existsSync } from "fs";
import { logger } from "../utils/logger";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db } from "../db";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import * as oldSchema from "../db/sqlite_schema";

const convertTimestamp = (value: any): Date => {
  if (!value) return new Date();
  return new Date(typeof value === "number" ? value : value);
};

async function migrateTable<T extends { id: string }>(
  tableName: string,
  sqliteTable: any,
  postgresTable: any,
  data: T[],
  convertFn: (item: T) => any,
  checkExistsFn: (id: string) => Promise<any>,
  getLogName: (item: T) => string,
) {
  logger.info(`Migrating ${tableName} table...`, { context: "SQLITE_MIGRATE" });
  logger.info(`Found ${data.length} ${tableName} in SQLite`, {
    context: "SQLITE_MIGRATE",
  });

  for (const item of data) {
    const existing = await checkExistsFn(item.id);
    if (!existing) {
      await db.insert(postgresTable).values(convertFn(item));
      logger.info(`Migrated ${tableName}: ${getLogName(item)}`, {
        context: "SQLITE_MIGRATE",
      });
    }
  }

  logger.info(`Successfully migrated ${data.length} ${tableName}`, {
    context: "SQLITE_MIGRATE",
  });
}

async function migrateSqliteToPostgres() {
  const sqliteDbPath = "audiostream.db";

  if (!existsSync(sqliteDbPath)) {
    logger.info("No SQLite database found, skipping migration", {
      context: "SQLITE_MIGRATE",
    });
    return;
  }

  logger.info(
    `Found SQLite database at ${sqliteDbPath}, starting migration...`,
    { context: "SQLITE_MIGRATE" },
  );

  try {
    const sqlite = new Database(sqliteDbPath, { readonly: true });
    const sqliteDb = drizzle(sqlite);

    const audioFilesData = await sqliteDb.select().from(oldSchema.audioFiles);
    await migrateTable(
      "audio_files",
      oldSchema.audioFiles,
      schema.audioFiles,
      audioFilesData,
      (audioFile) => ({
        ...audioFile,
        uploadedAt: convertTimestamp(audioFile.uploadedAt),
      }),
      (id) => AudioRepository.findById(id),
      (item) => item.filename,
    );

    const usersData = await sqliteDb.select().from(oldSchema.users);
    await migrateTable(
      "users",
      oldSchema.users,
      schema.users,
      usersData,
      (user) => ({
        ...user,
        createdAt: convertTimestamp(user.createdAt),
        lastLoginAt: user.lastLoginAt
          ? convertTimestamp(user.lastLoginAt)
          : null,
      }),
      (id) => UserRepository.findById(id),
      (item) => item.username,
    );

    const audioFileUsersData = await sqliteDb
      .select()
      .from(oldSchema.audioFileUsers);
    logger.info("Migrating audio_file_users table...", {
      context: "SQLITE_MIGRATE",
    });
    logger.info(
      `Found ${audioFileUsersData.length} audio_file_users in SQLite`,
      { context: "SQLITE_MIGRATE" },
    );

    for (const audioFileUser of audioFileUsersData) {
      const existing = await db
        .select()
        .from(schema.audioFileUsers)
        .where(eq(schema.audioFileUsers.id, audioFileUser.id));
      if (existing.length === 0) {
        await db.insert(schema.audioFileUsers).values(audioFileUser);
      }
    }
    logger.info(
      `Successfully migrated ${audioFileUsersData.length} audio_file_users`,
      { context: "SQLITE_MIGRATE" },
    );

    const playlistsData = await sqliteDb.select().from(oldSchema.playlists);
    await migrateTable(
      "playlists",
      oldSchema.playlists,
      schema.playlists,
      playlistsData,
      (playlist) => ({
        ...playlist,
        createdAt: convertTimestamp(playlist.createdAt),
        updatedAt: convertTimestamp(playlist.updatedAt),
      }),
      (id) => PlaylistRepository.findById(id),
      (item) => item.name,
    );

    const playlistItemsData = await sqliteDb
      .select()
      .from(oldSchema.playlistItems);
    logger.info("Migrating playlist_items table...", {
      context: "SQLITE_MIGRATE",
    });
    logger.info(`Found ${playlistItemsData.length} playlist_items in SQLite`, {
      context: "SQLITE_MIGRATE",
    });

    for (const playlistItem of playlistItemsData) {
      const existing = await db
        .select()
        .from(schema.playlistItems)
        .where(eq(schema.playlistItems.id, playlistItem.id));
      if (existing.length === 0) {
        await db.insert(schema.playlistItems).values({
          ...playlistItem,
          addedAt: convertTimestamp(playlistItem.addedAt),
        });
      }
    }
    logger.info(
      `Successfully migrated ${playlistItemsData.length} playlist_items`,
      { context: "SQLITE_MIGRATE" },
    );

    sqlite.close();
    logger.info("SQLite to PostgreSQL migration completed successfully!", {
      context: "SQLITE_MIGRATE",
    });
  } catch (error) {
    logger.error("SQLite to PostgreSQL migration failed", error, {
      context: "SQLITE_MIGRATE",
    });
    throw error;
  }
}

async function main() {
  logger.info("Running database migrations...", { context: "DB" });
  migrate(db, { migrationsFolder: "./src/db/migrations" });
  logger.info("Migrations completed successfully!", { context: "DB" });

  await migrateSqliteToPostgres();
}

export default main;
