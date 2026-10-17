import { status } from "elysia";
import { AudioRepository, RadioRepository } from "../../db/repositories";
import { logger } from "../../utils/logger";
import {
  buildRadioQueue,
  cosineSimilarity,
  extractMonoSlice,
  getActiveRadioModel,
  getExtractor,
  getRadioTuning,
  padToSharedWidth,
} from "../../utils/radio";
import type { AudioModel } from "../audio/model";

export interface RadioOptions {
  limit?: number;
  lambda?: number;
  temperature?: number;
  seed?: string;
  artistCooldown?: number;
  albumCooldown?: number;
}

export interface RadioResult {
  files: AudioModel.audioFile[];
  seedId: string;
  model: string;
  dim: number;
  coverage: number;
  indexedCount: number;
  totalCount: number;
}

const HNSW_SHORTLIST_LIMIT = 500;
const MAX_INDEX_ATTEMPTS = 3;

const pending = new Set<string>();
const failedAttempts = new Map<string, number>();
let sweeping = false;
let timer: Timer | null = null;

export abstract class RadioService {
  static enqueueIndex(audioId: string): void {
    failedAttempts.delete(audioId);
    pending.add(audioId);
    void this.drain().catch(() => {});
  }

  private static async drain(): Promise<void> {
    if (sweeping) return;
    const tuning = getRadioTuning();
    if (!tuning.autoIndex) return;
    sweeping = true;
    try {
      while (pending.size > 0) {
        const next = pending.values().next().value as string | undefined;
        if (!next) break;
        pending.delete(next);
        await this.indexOneTrack(next);
      }
    } finally {
      sweeping = false;
    }
  }

  static async indexOneTrack(
    audioId: string,
    trackHint?: { filename: string; duration: number | null },
  ): Promise<Float32Array | null> {
    const spec = getActiveRadioModel();
    const tuning = getRadioTuning();
    try {
      const existing = await RadioRepository.findByAudioId(audioId, spec.dim);
      if (existing && existing.modelName === spec.name && existing.analysisVersion === spec.analysisVersion) {
        failedAttempts.delete(audioId);
        return existing.embedding;
      }
      const track = trackHint ?? (await AudioRepository.findById(audioId));
      if (!track) return null;

      const extractor = await getExtractor();
      const pcm = await extractMonoSlice({
        filename: track.filename,
        durationSec: track.duration,
        sliceSeconds: tuning.sliceSeconds,
        targetSampleRate: extractor.sampleRate,
      });
      const native = await extractor.extract(pcm);
      const nativeTrimmed = native.length === spec.dim ? native : native.subarray(0, spec.dim);
      const padded = padToSharedWidth(nativeTrimmed, spec.dim, spec.paddedDim);
      await RadioRepository.upsertEmbedding(audioId, spec.name, padded, spec.analysisVersion);
      failedAttempts.delete(audioId);
      return nativeTrimmed;
    } catch (error) {
      const attempts = (failedAttempts.get(audioId) ?? 0) + 1;
      failedAttempts.set(audioId, attempts);
      logger.warn(
        `[RADIO] index failed for ${audioId} (attempt ${attempts}/${MAX_INDEX_ATTEMPTS}): ${error instanceof Error ? error.message : String(error)}`,
        { context: "RADIO" },
      );
      return null;
    }
  }

  static async ensureTrackVector(
    audioId: string,
    trackHint?: { filename: string; duration: number | null },
  ): Promise<Float32Array | null> {
    const spec = getActiveRadioModel();
    const existing = await RadioRepository.findByAudioId(audioId, spec.dim);
    if (existing && existing.modelName === spec.name && existing.analysisVersion === spec.analysisVersion) {
      return existing.embedding;
    }
    return await this.indexOneTrack(audioId, trackHint);
  }

  private static async sweepOnce(): Promise<void> {
    const spec = getActiveRadioModel();
    const tuning = getRadioTuning();
    if (!tuning.autoIndex) return;
    try {
      const exhaustedIds = new Set<string>();
      for (const [id, count] of failedAttempts) {
        if (count >= MAX_INDEX_ATTEMPTS) exhaustedIds.add(id);
      }
      const missing = await RadioRepository.findUnindexedIds(spec.name, spec.analysisVersion, 25, exhaustedIds);
      for (const m of missing) pending.add(m.id);
      await this.drain();
    } catch (error) {
      logger.debug("[RADIO] sweep failed", error, { context: "RADIO" });
    }
  }

  static startIndexer(): void {
    const tuning = getRadioTuning();
    if (!tuning.autoIndex) {
      logger.info("[RADIO] auto-index disabled (RADIO_AUTO_INDEX=false)", { context: "RADIO" });
      return;
    }
    if (timer) return;
    const spec = getActiveRadioModel();
    logger.info(`[RADIO] indexer started (model=${spec.name}, dim=${spec.dim})`, { context: "RADIO" });
    timer = setInterval(() => {
      void this.sweepOnce();
    }, tuning.sweepIntervalMs);
    void this.sweepOnce();
  }

  static async getRadio(seedId: string, userId: string, opts: RadioOptions = {}): Promise<RadioResult> {
    const spec = getActiveRadioModel();
    const tuning = getRadioTuning();
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
    const lambda = opts.lambda ?? tuning.lambda;
    const temperature = opts.temperature ?? tuning.temperature;

    const seedTrack = await AudioRepository.findById(seedId, userId);
    if (!seedTrack) throw status(404, "Seed track not found");

    const seedNative = await this.ensureTrackVector(seedId, seedTrack);
    if (!seedNative) throw status(422, "Seed track could not be analyzed yet — try again shortly");

    const seedPadded =
      spec.dim === spec.paddedDim
        ? seedNative
        : padToSharedWidth(seedNative, spec.dim, spec.paddedDim);
    const candidateCap = Math.min(tuning.maxCandidates, Math.max(HNSW_SHORTLIST_LIMIT, limit * 8));

    const [candidates, stats] = await Promise.all([
      RadioRepository.findCandidateEmbeddings(userId, spec.name, candidateCap, {
        nativeDim: spec.dim,
        seedPadded,
      }),
      RadioRepository.countStats(spec.name, spec.analysisVersion),
    ]);

    if (candidates.length === 0) {
      throw status(422, "Radio index is empty — background indexing is still running");
    }

    const picked = buildRadioQueue(seedNative, seedId, candidates, {
      limit,
      lambda,
      temperature,
      topK: tuning.topK,
      artistCooldown: opts.artistCooldown ?? tuning.artistCooldown,
      albumCooldown: opts.albumCooldown ?? tuning.albumCooldown,
      rngSeed: opts.seed ?? `${seedId}:${Date.now()}`,
      seedArtist: seedTrack.artist,
      seedAlbum: seedTrack.album,
    });

    const fullRows = await AudioRepository.findByIds(picked.map((p) => p.id));
    const fullById = new Map(fullRows.map((row) => [row.id, row]));
    const files: AudioModel.audioFile[] = [];
    for (const p of picked) {
      const full = fullById.get(p.id);
      if (full) files.push(AudioRepository.toAudioModel(full));
    }

    const { indexedCount, totalCount } = stats;

    return {
      files,
      seedId,
      model: spec.name,
      dim: spec.dim,
      coverage: totalCount === 0 ? 0 : indexedCount / totalCount,
      indexedCount,
      totalCount,
    };
  }

  static async getStatus(): Promise<{
    model: string;
    dim: number;
    sampleRate: number;
    indexedCount: number;
    totalCount: number;
    coverage: number;
  }> {
    const spec = getActiveRadioModel();
    const { indexedCount, totalCount } = await RadioRepository.countStats(spec.name, spec.analysisVersion);
    return {
      model: spec.name,
      dim: spec.dim,
      sampleRate: spec.sampleRate,
      indexedCount,
      totalCount,
      coverage: totalCount === 0 ? 0 : indexedCount / totalCount,
    };
  }

  static async similarityToSeed(seedId: string, otherId: string): Promise<number> {
    const [a, b] = await Promise.all([this.ensureTrackVector(seedId), this.ensureTrackVector(otherId)]);
    if (!a || !b) throw status(404, "Embedding missing for one of the tracks");
    return cosineSimilarity(a, b);
  }
}
