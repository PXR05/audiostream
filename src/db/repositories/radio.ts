import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "../index";
import { audioEmbeddings, audioFiles, audioFileUsers } from "../schema";
import { toPgVectorLiteral } from "../../utils/radio";

export interface CandidateRow {
  id: string;
  filename: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  duration: number | null;
  vector: Float32Array;
}

function parseVectorFloat32(raw: unknown, dim?: number): Float32Array | null {
  if (raw instanceof Float32Array) {
    return dim !== undefined && raw.length !== dim ? raw.subarray(0, dim) : raw;
  }
  if (Array.isArray(raw)) {
    const n = dim !== undefined ? Math.min(dim, raw.length) : raw.length;
    const out = new Float32Array(dim ?? n);
    for (let i = 0; i < n; i++) out[i] = Number(raw[i]) || 0;
    return out;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length < 2 || trimmed[0] !== "[") return null;
    const body = trimmed.slice(1, -1);
    if (!body) return null;
    const parts = body.split(",");
    const targetLen = dim ?? parts.length;
    const n = Math.min(targetLen, parts.length);
    const out = new Float32Array(targetLen);
    for (let i = 0; i < n; i++) out[i] = parseFloat(parts[i]!) || 0;
    return out;
  }
  return null;
}

function userAccessCondition(userId: string) {
  return or(
    eq(audioFiles.isPublic, 1),
    sql`EXISTS (
      SELECT 1 FROM ${audioFileUsers}
      WHERE ${audioFileUsers.audioFileId} = ${audioFiles.id}
        AND ${audioFileUsers.userId} = ${userId}
        AND ${audioFileUsers.deletedAt} IS NULL
    )`,
  )!;
}

export abstract class RadioRepository {
  static async upsertEmbedding(
    audioId: string,
    modelName: string,
    embedding1280: number[],
    analysisVersion: number,
  ): Promise<void> {
    const now = new Date();
    await db
      .insert(audioEmbeddings)
      .values({ audioId, modelName, embedding: embedding1280 as never, analysisVersion, updatedAt: now })
      .onConflictDoUpdate({
        target: audioEmbeddings.audioId,
        set: { modelName, embedding: embedding1280 as never, analysisVersion, updatedAt: now },
      });
  }

  static async findByAudioId(
    audioId: string,
    dim?: number,
  ): Promise<{ modelName: string; embedding: Float32Array; analysisVersion: number } | null> {
    const rows = await db.select().from(audioEmbeddings).where(eq(audioEmbeddings.audioId, audioId)).limit(1);
    const row = rows[0];
    if (!row) return null;
    const embedding = parseVectorFloat32(row.embedding as unknown, dim);
    if (!embedding) return null;
    return { modelName: row.modelName, embedding, analysisVersion: row.analysisVersion };
  }

  static async findUnindexedIds(
    modelName: string,
    analysisVersion: number,
    limit: number,
    excludeIds?: Iterable<string>,
  ): Promise<{ id: string; filename: string; duration: number | null }[]> {
    const excluded = excludeIds ? Array.from(excludeIds) : [];
    const conditions = [
      isNull(audioFiles.deletedAt),
      or(
        isNull(audioEmbeddings.audioId),
        sql`${audioEmbeddings.modelName} != ${modelName} OR ${audioEmbeddings.analysisVersion} != ${analysisVersion}`,
      ),
    ];
    if (excluded.length > 0) {
      conditions.push(sql`${audioFiles.id} NOT IN (${sql.join(excluded.map((id) => sql`${id}`), sql`, `)})`);
    }
    return await db
      .select({ id: audioFiles.id, filename: audioFiles.filename, duration: audioFiles.duration })
      .from(audioFiles)
      .leftJoin(audioEmbeddings, eq(audioFiles.id, audioEmbeddings.audioId))
      .where(and(...conditions))
      .limit(limit);
  }

  static async countStats(
    modelName: string,
    analysisVersion?: number,
  ): Promise<{ indexedCount: number; totalCount: number }> {
    const versionClause =
      analysisVersion !== undefined
        ? sql`AND ${audioEmbeddings.analysisVersion} = ${analysisVersion}`
        : sql``;
    const rows = await db
      .select({
        totalCount: sql<number>`count(*)::int`,
        indexedCount: sql<number>`count(${audioEmbeddings.audioId}) FILTER (WHERE ${audioEmbeddings.modelName} = ${modelName} ${versionClause})::int`,
      })
      .from(audioFiles)
      .leftJoin(audioEmbeddings, eq(audioFiles.id, audioEmbeddings.audioId))
      .where(isNull(audioFiles.deletedAt));
    return {
      indexedCount: rows[0]?.indexedCount ?? 0,
      totalCount: rows[0]?.totalCount ?? 0,
    };
  }

  static async countIndexed(modelName: string, analysisVersion?: number): Promise<number> {
    const { indexedCount } = await this.countStats(modelName, analysisVersion);
    return indexedCount;
  }

  static async countTracks(): Promise<number> {
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(audioFiles)
      .where(isNull(audioFiles.deletedAt));
    return rows[0]?.count ?? 0;
  }

  static async findCandidateEmbeddings(
    userId: string,
    modelName: string,
    maxCandidates: number,
    options?: {
      nativeDim?: number;
      seedPadded?: number[] | Float32Array;
    },
  ): Promise<CandidateRow[]> {
    const baseQuery = db
      .select({
        id: audioFiles.id,
        filename: audioFiles.filename,
        title: audioFiles.title,
        artist: audioFiles.artist,
        album: audioFiles.album,
        duration: audioFiles.duration,
        embedding: audioEmbeddings.embedding,
      })
      .from(audioFiles)
      .innerJoin(audioEmbeddings, eq(audioFiles.id, audioEmbeddings.audioId))
      .where(
        and(
          isNull(audioFiles.deletedAt),
          eq(audioEmbeddings.modelName, modelName),
          userAccessCondition(userId),
        ),
      );

    const rows = options?.seedPadded
      ? await baseQuery
          .orderBy(sql`${audioEmbeddings.embedding} <=> ${toPgVectorLiteral(options.seedPadded)}::vector`)
          .limit(maxCandidates)
      : await baseQuery.limit(maxCandidates);

    const out: CandidateRow[] = [];
    for (const r of rows) {
      const vector = parseVectorFloat32(r.embedding as unknown, options?.nativeDim);
      if (!vector || vector.length === 0) continue;
      out.push({
        id: r.id,
        filename: r.filename,
        title: r.title,
        artist: r.artist,
        album: r.album,
        duration: r.duration,
        vector,
      });
    }
    return out;
  }

  static async findNearestIds(
    userId: string,
    modelName: string,
    seedPadded1280: number[] | Float32Array,
    limit: number,
  ): Promise<string[]> {
    const literal = toPgVectorLiteral(seedPadded1280);
    const rows = await db
      .select({ id: audioFiles.id })
      .from(audioFiles)
      .innerJoin(audioEmbeddings, eq(audioFiles.id, audioEmbeddings.audioId))
      .where(
        and(
          isNull(audioFiles.deletedAt),
          eq(audioEmbeddings.modelName, modelName),
          userAccessCondition(userId),
        ),
      )
      .orderBy(sql`${audioEmbeddings.embedding} <=> ${literal}::vector`)
      .limit(limit);
    return rows.map((r) => r.id);
  }
}
