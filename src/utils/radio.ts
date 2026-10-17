import { existsSync } from "fs";
import { join } from "path";
import { MODELS_DIR, TEMP_DIR } from "./helpers";
import { logger } from "./logger";
import { Storage } from "./storage";

// ============================================================================
// Model & Tuning Configuration
// ============================================================================

export type RadioModelName = "effnet" | "musicnn" | "clap";

export interface RadioModelSpec {
  name: RadioModelName;
  dim: number;
  paddedDim: number;
  sampleRate: number;
  file: string;
  analysisVersion: number;
  melBands: number;
  patchFrames: number;
  layout: "bhw" | "bchw";
  description: string;
}

export const PADDED_DIM = 1280;

export const RADIO_MODELS: Record<RadioModelName, RadioModelSpec> = {
  effnet: {
    name: "effnet",
    dim: 1280,
    paddedDim: PADDED_DIM,
    sampleRate: 16000,
    file: "effnet.onnx",
    analysisVersion: 1,
    melBands: 96,
    patchFrames: 128,
    layout: "bhw",
    description: "Discogs-EffNet (400 styles, fine-grained sub-genres)",
  },
  musicnn: {
    name: "musicnn",
    dim: 200,
    paddedDim: PADDED_DIM,
    sampleRate: 16000,
    file: "musicnn.onnx",
    analysisVersion: 1,
    melBands: 96,
    patchFrames: 187,
    layout: "bchw",
    description: "MusiCNN (50 macro tags, ultra-lightweight)",
  },
  clap: {
    name: "clap",
    dim: 512,
    paddedDim: PADDED_DIM,
    sampleRate: 48000,
    file: "clap.onnx",
    analysisVersion: 1,
    melBands: 64,
    patchFrames: 0,
    layout: "bhw",
    description: "LAION-CLAP music ckpt (semantic vibe + text search)",
  },
};

function parseModelName(raw: string | undefined): RadioModelName {
  const v = (raw ?? "effnet").trim().toLowerCase();
  if (v === "effnet" || v === "musicnn" || v === "clap") return v;
  logger.warn(`[RADIO] Unknown RADIO_MODEL="${raw}", falling back to effnet`, { context: "RADIO" });
  return "effnet";
}

function parseNum(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface RadioTuning {
  sliceSeconds: number;
  lambda: number;
  temperature: number;
  topK: number;
  artistCooldown: number;
  albumCooldown: number;
  autoIndex: boolean;
  sweepIntervalMs: number;
  maxCandidates: number;
}

export function getActiveRadioModel(): RadioModelSpec {
  return RADIO_MODELS[parseModelName(process.env.RADIO_MODEL)];
}

export function getRadioModelDir(): string {
  return process.env.RADIO_MODEL_DIR?.trim() || MODELS_DIR;
}

export function getRadioTuning(): RadioTuning {
  return {
    sliceSeconds: parseNum(process.env.RADIO_SLICE_SECONDS, 30),
    lambda: Number(process.env.RADIO_MMR_LAMBDA ?? 0.7),
    temperature: Number(process.env.RADIO_TEMPERATURE ?? 0.08),
    topK: Math.floor(parseNum(process.env.RADIO_TOP_K, 25)),
    artistCooldown: Math.floor(parseNum(process.env.RADIO_ARTIST_COOLDOWN, 4)),
    albumCooldown: Math.floor(parseNum(process.env.RADIO_ALBUM_COOLDOWN, 3)),
    autoIndex: (process.env.RADIO_AUTO_INDEX ?? "true").toLowerCase() !== "false",
    sweepIntervalMs: Math.floor(parseNum(process.env.RADIO_SWEEP_INTERVAL_MS, 5000)),
    maxCandidates: Math.floor(parseNum(process.env.RADIO_MAX_CANDIDATES, 20000)),
  };
}

// ============================================================================
// FFmpeg Audio Slicing
// ============================================================================

export interface SliceOptions {
  filename: string;
  durationSec?: number | null;
  sliceSeconds: number;
  targetSampleRate: number;
}

export async function extractMonoSlice(opts: SliceOptions): Promise<Float32Array> {
  const { filename, durationSec, sliceSeconds, targetSampleRate } = opts;
  const inputPath = await resolveInputPath(filename);
  const start =
    durationSec && durationSec > sliceSeconds
      ? Math.max(0, durationSec / 2 - sliceSeconds / 2)
      : 0;

  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      start.toFixed(2),
      "-t",
      String(sliceSeconds),
      "-i",
      inputPath,
      "-vn",
      "-f",
      "f32le",
      "-acodec",
      "pcm_f32le",
      "-ac",
      "1",
      "-ar",
      String(targetSampleRate),
      "pipe:1",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  const [pcmBuf, errText] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  await cleanupTempInput(inputPath, filename);

  if (exitCode !== 0) {
    throw new Error(`ffmpeg slice failed for ${filename}: ${errText.trim() || `exit ${exitCode}`}`);
  }
  const sampleCount = Math.floor(pcmBuf.byteLength / 4);
  if (sampleCount === 0) {
    throw new Error(`ffmpeg produced no PCM for ${filename}`);
  }
  return new Float32Array(pcmBuf, 0, sampleCount);
}

async function resolveInputPath(filename: string): Promise<string> {
  const localPath = join(Storage.getLocalStorageDir(), filename);
  if (existsSync(localPath)) return localPath;
  const data = await Storage.download(filename);
  const tmpPath = join(TEMP_DIR, `radio_${Date.now()}_${Math.random().toString(36).slice(2)}_${filename}`);
  await Bun.write(tmpPath, data);
  return tmpPath;
}

async function cleanupTempInput(inputPath: string, filename: string): Promise<void> {
  const localPath = join(Storage.getLocalStorageDir(), filename);
  if (inputPath === localPath) return;
  try {
    const f = Bun.file(inputPath);
    if (await f.exists()) await f.unlink();
  } catch (error) {
    logger.debug(`Radio temp cleanup failed for ${inputPath}`, error, { context: "RADIO" });
  }
}

// ============================================================================
// FFT & Log-Mel Spectrogram DSP
// ============================================================================

const N_FFT = 512;
const HOP = 256;
const N_MELS = 96;
const PATCH_FRAMES = 128;
const FMIN = 0;
const FMAX = 8000;
const SAMPLE_RATE = 16000;
const N_BINS = (N_FFT >> 1) + 1;

const HANN = (() => {
  const w = new Float64Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N_FFT - 1)));
  return w;
})();

const BIT_REV = (() => {
  const rev = new Uint16Array(N_FFT);
  for (let i = 1, j = 0; i < N_FFT; i++) {
    let bit = N_FFT >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    rev[i] = j;
  }
  return rev;
})();

const { TWIDDLE_RE, TWIDDLE_IM } = (() => {
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  for (let len = 2; len <= N_FFT; len <<= 1) {
    const half = len >> 1;
    const ang = (-2 * Math.PI) / len;
    for (let k = 0; k < half; k++) {
      re[half + k] = Math.cos(ang * k);
      im[half + k] = Math.sin(ang * k);
    }
  }
  return { TWIDDLE_RE: re, TWIDDLE_IM: im };
})();

const fftRe = new Float64Array(N_FFT);
const fftIm = new Float64Array(N_FFT);
const fftPower = new Float64Array(N_BINS);

function computeFftPower(pcm: Float32Array, offset: number): Float64Array {
  for (let i = 0; i < N_FFT; i++) {
    const j = BIT_REV[i]!;
    fftRe[j] = pcm[offset + i]! * HANN[i]!;
    fftIm[j] = 0;
  }
  for (let len = 2; len <= N_FFT; len <<= 1) {
    const half = len >> 1;
    for (let i = 0; i < N_FFT; i += len) {
      for (let k = 0; k < half; k++) {
        const cwr = TWIDDLE_RE[half + k]!;
        const cwi = TWIDDLE_IM[half + k]!;
        const idxA = i + k;
        const idxB = idxA + half;
        const ur = fftRe[idxA]!;
        const ui = fftIm[idxA]!;
        const br = fftRe[idxB]!;
        const bi = fftIm[idxB]!;
        const vr = br * cwr - bi * cwi;
        const vi = br * cwi + bi * cwr;
        fftRe[idxA] = ur + vr;
        fftIm[idxA] = ui + vi;
        fftRe[idxB] = ur - vr;
        fftIm[idxB] = ui - vi;
      }
    }
  }
  const invN = 1 / N_FFT;
  for (let k = 0; k < N_BINS; k++) {
    const r = fftRe[k]!;
    const imv = fftIm[k]!;
    fftPower[k] = (r * r + imv * imv) * invN;
  }
  return fftPower;
}

function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}

function melToHz(mel: number): number {
  return 700 * (Math.pow(10, mel / 2595) - 1);
}

interface SparseMelBand {
  start: number;
  weights: Float64Array;
}

let cachedSparseFb: SparseMelBand[] | null = null;

function sparseMelFilterbank(): SparseMelBand[] {
  if (cachedSparseFb) return cachedSparseFb;
  const melMin = hzToMel(FMIN);
  const melMax = hzToMel(FMAX);
  const points = new Float64Array(N_MELS + 2);
  for (let i = 0; i < N_MELS + 2; i++) {
    points[i] = melToHz(melMin + ((melMax - melMin) * i) / (N_MELS + 1));
  }
  const fb: SparseMelBand[] = [];
  const temp = new Float64Array(N_BINS);
  for (let m = 1; m <= N_MELS; m++) {
    temp.fill(0);
    const f0 = points[m - 1]!;
    const f1 = points[m]!;
    const f2 = points[m + 1]!;
    let start = N_BINS;
    let end = 0;
    for (let k = 0; k < N_BINS; k++) {
      const hz = (k * SAMPLE_RATE) / N_FFT;
      let w = 0;
      if (hz >= f0 && hz <= f1 && f1 > f0) w = (hz - f0) / (f1 - f0);
      else if (hz > f1 && hz <= f2 && f2 > f1) w = (f2 - hz) / (f2 - f1);
      if (w > 0) {
        temp[k] = w;
        if (k < start) start = k;
        if (k + 1 > end) end = k + 1;
      }
    }
    if (start >= end) {
      fb.push({ start: 0, weights: new Float64Array(0) });
      continue;
    }
    let enorm = 0;
    for (let k = start; k < end; k++) enorm += temp[k]!;
    const scale = enorm > 0 ? 2 / enorm : 0;
    const weights = new Float64Array(end - start);
    for (let k = start; k < end; k++) weights[k - start] = temp[k]! * scale;
    fb.push({ start, weights });
  }
  cachedSparseFb = fb;
  return fb;
}

function writeLogMelFrame(power: Float64Array, fb: SparseMelBand[], out: Float32Array, outOffset: number): void {
  for (let m = 0; m < N_MELS; m++) {
    const band = fb[m]!;
    const { start, weights } = band;
    let s = 0;
    for (let i = 0, len = weights.length; i < len; i++) {
      s += power[start + i]! * weights[i]!;
    }
    out[outOffset + m] = Math.log10(10000 * s + 1);
  }
}

export function pcmToMelTensor(
  pcm: Float32Array,
  patchFrames = PATCH_FRAMES,
  layout: "bhw" | "bchw" = "bhw",
): { data: Float32Array; dims: number[]; numPatches: number } {
  const fb = sparseMelFilterbank();
  const numFrames = pcm.length >= N_FFT ? Math.floor((pcm.length - N_FFT) / HOP) + 1 : 0;
  const numPatches = numFrames >= patchFrames ? Math.floor(numFrames / patchFrames) : 1;
  const totalFramesToWrite = Math.min(numFrames, numPatches * patchFrames);
  const data = new Float32Array(numPatches * patchFrames * N_MELS);

  for (let f = 0; f < totalFramesToWrite; f++) {
    const power = computeFftPower(pcm, f * HOP);
    writeLogMelFrame(power, fb, data, f * N_MELS);
  }

  const dims =
    layout === "bchw"
      ? [numPatches, 1, patchFrames, N_MELS]
      : [numPatches, patchFrames, N_MELS];
  return { data, dims, numPatches };
}

export const MEL_SPEC = { nFft: N_FFT, hop: HOP, nMels: N_MELS, patchFrames: PATCH_FRAMES } as const;

// ============================================================================
// ONNX & Mock Audio Embedding Extractors
// ============================================================================

export interface RadioExtractor {
  readonly model: RadioModelName;
  readonly dimension: number;
  readonly sampleRate: number;
  extract(pcm: Float32Array): Promise<Float32Array>;
}

export function l2Normalize(vec: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i]!;
    sum += v * v;
  }
  const invNorm = sum > 0 ? 1 / Math.sqrt(sum) : 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i]! * invNorm;
  return out;
}

export function padToSharedWidth(vec: Float32Array | number[], nativeDim: number, paddedDim: number): number[] {
  const out = new Array<number>(paddedDim).fill(0);
  const n = Math.min(nativeDim, paddedDim, vec.length);
  for (let i = 0; i < n; i++) out[i] = vec[i]!;
  return out;
}

export function unpadFromSharedWidth(row: number[] | Float32Array, nativeDim: number): Float32Array {
  if (row instanceof Float32Array) {
    return row.length === nativeDim ? row : row.subarray(0, nativeDim);
  }
  const out = new Float32Array(nativeDim);
  const n = Math.min(nativeDim, row.length);
  for (let i = 0; i < n; i++) out[i] = row[i]!;
  return out;
}

export function toPgVectorLiteral(vec: number[] | Float32Array): string {
  return `[${vec.join(",")}]`;
}

export class MockRadioExtractor implements RadioExtractor {
  readonly model: RadioModelName;
  readonly dimension: number;
  readonly sampleRate: number;

  constructor(model: RadioModelName, dimension: number, sampleRate: number) {
    this.model = model;
    this.dimension = dimension;
    this.sampleRate = sampleRate;
  }

  async extract(pcm: Float32Array): Promise<Float32Array> {
    let energy = 0;
    let zeroCross = 0;
    const stride = Math.max(1, Math.floor(pcm.length / 4096));
    for (let i = 0; i < pcm.length; i += stride) {
      energy += Math.abs(pcm[i]!);
      if (i > 0 && Math.sign(pcm[i]!) !== Math.sign(pcm[i - stride]!)) zeroCross++;
    }
    let h = (Math.floor(energy * 1e6) ^ (zeroCross * 2654435761)) >>> 0;
    const rand = () => {
      h = (h + 0x6d2b79f5) | 0;
      let t = Math.imul(h ^ (h >>> 15), 1 | h);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const out = new Float32Array(this.dimension);
    for (let i = 0; i < this.dimension; i++) out[i] = rand() * 2 - 1;
    return l2Normalize(out);
  }
}

interface OrtSession {
  readonly inputNames: string[];
  readonly outputNames: string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: ArrayLike<number> }>>;
}

interface OrtModule {
  Tensor: new (type: "float32", data: Float32Array, dims: number[]) => unknown;
  InferenceSession: { create(path: string): Promise<OrtSession> };
}

export class OnnxRadioExtractor implements RadioExtractor {
  readonly model: RadioModelName;
  readonly dimension: number;
  readonly sampleRate: number;
  private readonly spec: RadioModelSpec;
  private session: OrtSession | null = null;
  private ort: OrtModule | null = null;
  private loadPromise: Promise<void> | null = null;
  private readonly modelPath: string;

  constructor(spec: RadioModelSpec, modelPath: string) {
    this.spec = spec;
    this.model = spec.name;
    this.dimension = spec.dim;
    this.sampleRate = spec.sampleRate;
    this.modelPath = modelPath;
  }

  private ensureLoaded(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        const ort = (await import("onnxruntime-node")) as unknown as OrtModule;
        this.ort = ort;
        this.session = await ort.InferenceSession.create(this.modelPath);
        logger.info(
          `[RADIO] ONNX session loaded: ${this.modelPath} (in=${this.session.inputNames.join(",")} out=${this.session.outputNames.join(",")})`,
          { context: "RADIO" },
        );
      })();
    }
    return this.loadPromise;
  }

  private pickEmbeddingOutput(
    out: Record<string, { data: ArrayLike<number> }>,
    outputNames: string[],
    batch: number,
  ): { name: string; rows: Float32Array; perRow: number } {
    const candidates = outputNames.map((name) => ({
      name,
      data: out[name]!.data,
      perRow: out[name]!.data.length / batch,
    }));
    let best = candidates.find((c) => c.perRow === this.dimension);
    if (!best) {
      const hinted = candidates.find((c) => /partitionedcall:1|dense\/biasadd|embedding|flatten/i.test(c.name));
      best = hinted ?? candidates.sort((a, b) => b.perRow - a.perRow)[0];
    }
    if (!best) throw new Error("ONNX model returned no outputs");
    if (best.perRow !== this.dimension) {
      logger.warn(
        `[RADIO] embedding head mismatch (got ${best.perRow}d, want ${this.dimension}d) — truncating/padding`,
        { context: "RADIO" },
      );
    }
    const rows = best.data instanceof Float32Array ? best.data : Float32Array.from(best.data);
    return { name: best.name, rows, perRow: best.perRow };
  }

  async extract(pcm: Float32Array): Promise<Float32Array> {
    await this.ensureLoaded();
    if (!this.session || !this.ort) throw new Error("ONNX session failed to load");
    const { data, dims, numPatches } = pcmToMelTensor(pcm, this.spec.patchFrames, this.spec.layout);
    const tensor = new this.ort.Tensor("float32", data, dims);
    const out = await this.session.run({ [this.session.inputNames[0]!]: tensor });
    const { rows, perRow } = this.pickEmbeddingOutput(out, this.session.outputNames, numPatches);
    const stride = Math.floor(perRow);
    const copyLen = Math.min(stride, this.dimension);
    const fixed = new Float32Array(this.dimension);
    for (let b = 0; b < numPatches; b++) {
      const base = b * stride;
      for (let i = 0; i < copyLen; i++) {
        fixed[i] = fixed[i]! + rows[base + i]!;
      }
    }
    return l2Normalize(fixed);
  }
}

let cachedExtractor: RadioExtractor | null = null;

export async function getExtractor(): Promise<RadioExtractor> {
  if (cachedExtractor) return cachedExtractor;
  const spec = getActiveRadioModel();
  if (spec.name === "clap") {
    logger.warn("[RADIO] CLAP HTSAT preprocessing not implemented yet — using mock embeddings", {
      context: "RADIO",
    });
    cachedExtractor = new MockRadioExtractor(spec.name, spec.dim, spec.sampleRate);
    return cachedExtractor;
  }
  const path = `${getRadioModelDir()}/${spec.file}`.replace(/\/+/g, "/");
  const file = Bun.file(path);
  if (await file.exists()) {
    try {
      const onnx = new OnnxRadioExtractor(spec, path);
      await onnx.extract(new Float32Array(spec.sampleRate));
      cachedExtractor = onnx;
      return cachedExtractor;
    } catch (error) {
      logger.warn(`[RADIO] ONNX load failed for ${path}, using mock embeddings`, { context: "RADIO" });
      logger.debug(String(error), undefined, { context: "RADIO" });
    }
  } else {
    logger.warn(
      `[RADIO] Model file missing: ${path} — using mock embeddings (download ${spec.file} into RADIO_MODEL_DIR)`,
      { context: "RADIO" },
    );
  }
  cachedExtractor = new MockRadioExtractor(spec.name, spec.dim, spec.sampleRate);
  return cachedExtractor;
}

export function resetExtractorCache(): void {
  cachedExtractor = null;
}

// ============================================================================
// MMR + Cooldown + Softmax Queue Builder
// ============================================================================

export interface RadioCandidate {
  id: string;
  vector: Float32Array;
  artist?: string | null;
  album?: string | null;
}

export interface QueueOptions {
  limit: number;
  lambda: number;
  temperature: number;
  topK: number;
  artistCooldown: number;
  albumCooldown: number;
  rngSeed?: string;
  seedArtist?: string | null;
  seedAlbum?: string | null;
}

function createRng(seed: string): () => number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  return () => {
    hash = (hash + 0x6d2b79f5) | 0;
    let t = Math.imul(hash ^ (hash >>> 15), 1 | hash);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += (a[i] as number) * (b[i] as number);
  return dot;
}

function normKey(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase();
}

function violatesCooldownNorm(
  artistNorm: string,
  albumNorm: string,
  recentArtists: string[],
  recentAlbums: string[],
  artistCooldown: number,
  albumCooldown: number,
): boolean {
  if (artistNorm && artistCooldown > 0) {
    const start = Math.max(0, recentArtists.length - artistCooldown);
    for (let i = start; i < recentArtists.length; i++) {
      if (recentArtists[i] === artistNorm) return true;
    }
  }
  if (albumNorm && albumCooldown > 0) {
    const start = Math.max(0, recentAlbums.length - albumCooldown);
    for (let i = start; i < recentAlbums.length; i++) {
      if (recentAlbums[i] === albumNorm) return true;
    }
  }
  return false;
}

interface IndexedCandidate {
  cand: RadioCandidate;
  artistNorm: string;
  albumNorm: string;
  recentSims: Float32Array;
}

const NOVELTY_WINDOW = 8;

export function buildRadioQueue(
  seed: Float32Array,
  excludeId: string,
  candidates: RadioCandidate[],
  opts: QueueOptions,
): RadioCandidate[] {
  const rng = createRng(opts.rngSeed ?? `${Date.now()}:${Math.random()}`);
  const pool: IndexedCandidate[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    if (c.id === excludeId) continue;
    pool.push({
      cand: c,
      artistNorm: normKey(c.artist),
      albumNorm: normKey(c.album),
      recentSims: new Float32Array(NOVELTY_WINDOW),
    });
  }

  const picked: RadioCandidate[] = [];
  const recentArtists: string[] = [];
  const recentAlbums: string[] = [];
  if (opts.seedArtist || opts.seedAlbum) {
    recentArtists.push(normKey(opts.seedArtist));
    recentAlbums.push(normKey(opts.seedAlbum));
  }

  const anchor = new Float32Array(seed.length);
  anchor.set(seed);

  const limit = Math.min(opts.limit, pool.length);
  const scored: { idx: number; mmr: number; cooldown: boolean }[] = [];
  const eligible: { idx: number; mmr: number }[] = [];

  while (picked.length < limit && pool.length > 0) {
    scored.length = 0;
    eligible.length = 0;
    const simCount = Math.min(picked.length, NOVELTY_WINDOW);

    for (let i = 0; i < pool.length; i++) {
      const item = pool[i]!;
      const sim = cosineSimilarity(anchor, item.cand.vector);
      let novelty = 0;
      for (let w = 0; w < simCount; w++) {
        const s = item.recentSims[w]!;
        if (s > novelty) novelty = s;
      }
      const cooldown = violatesCooldownNorm(
        item.artistNorm,
        item.albumNorm,
        recentArtists,
        recentAlbums,
        opts.artistCooldown,
        opts.albumCooldown,
      );
      const mmr = opts.lambda * sim - (1 - opts.lambda) * novelty - (cooldown ? 1 : 0);
      scored.push({ idx: i, mmr, cooldown });
    }

    scored.sort((x, y) => y.mmr - x.mmr);

    for (let i = 0; i < scored.length; i++) {
      const s = scored[i]!;
      if (!s.cooldown) eligible.push(s);
    }
    const activeList = eligible.length > 0 ? eligible : scored;
    const effectiveTopK =
      activeList.length <= opts.topK
        ? Math.max(1, Math.ceil(activeList.length * 0.5))
        : opts.topK;
    const k = Math.max(1, Math.min(effectiveTopK, activeList.length));

    const tau = Math.max(1e-6, opts.temperature);
    const maxMmr = activeList[0]!.mmr;
    let totalWeight = 0;
    const weights = new Float64Array(k);
    for (let i = 0; i < k; i++) {
      const w = Math.exp((activeList[i]!.mmr - maxMmr) / tau);
      weights[i] = w;
      totalWeight += w;
    }

    let r = rng() * (totalWeight || 1);
    let chosenPoolIdx = activeList[0]!.idx;
    for (let i = 0; i < k; i++) {
      r -= weights[i]!;
      if (r <= 0) {
        chosenPoolIdx = activeList[i]!.idx;
        break;
      }
    }

    const chosenItem = pool[chosenPoolIdx]!;
    const chosen = chosenItem.cand;
    const ringSlot = picked.length % NOVELTY_WINDOW;
    picked.push(chosen);
    recentArtists.push(chosenItem.artistNorm);
    recentAlbums.push(chosenItem.albumNorm);

    const lastIdx = pool.length - 1;
    if (chosenPoolIdx !== lastIdx) {
      pool[chosenPoolIdx] = pool[lastIdx]!;
    }
    pool.pop();

    for (let i = 0; i < pool.length; i++) {
      const item = pool[i]!;
      item.recentSims[ringSlot] = cosineSimilarity(item.cand.vector, chosen.vector);
    }

    let normSq = 0;
    for (let i = 0; i < anchor.length; i++) {
      const v = 0.7 * seed[i]! + 0.3 * chosen.vector[i]!;
      anchor[i] = v;
      normSq += v * v;
    }
    const invNorm = normSq > 0 ? 1 / Math.sqrt(normSq) : 1;
    for (let i = 0; i < anchor.length; i++) anchor[i] = anchor[i]! * invNorm;
  }
  return picked;
}
