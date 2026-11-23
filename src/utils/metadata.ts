import { basename, extname } from "path";
import { TagLib, type Picture } from "taglib-wasm";
import type { AudioModel } from "../modules/audio/model";
import {
  extractCoverWithFfmpeg,
  processAndStoreCoverArt,
} from "./coverArt";
import { normalizeIsrc } from "./isrc";
import { logger } from "./logger";

export interface ExtractedReplayGain {
  trackGain?: number;
  trackPeak?: number;
  albumGain?: number;
  albumPeak?: number;
  r128TrackGain?: number;
  r128AlbumGain?: number;
}

export interface ExtractedMusicBrainz {
  trackId?: string;
  releaseId?: string;
  artistId?: string;
  releaseGroupId?: string;
}

export interface ExtractedExtraMetadata {
  albumArtist?: string;
  artists?: string[];
  albumArtists?: string[];
  trackNumber?: number;
  totalTracks?: number;
  discNumber?: number;
  totalDiscs?: number;
  releaseDate?: string;
  originalDate?: string;
  compilation?: boolean;
  bpm?: number;
  composer?: string[];
  label?: string;
  copyright?: string;
  upc?: string;
  explicit?: boolean;
  comment?: string;
  codec?: string;
  isLossless?: boolean;
  replayGain?: ExtractedReplayGain;
  musicbrainz?: ExtractedMusicBrainz;
  lyrics?: string;
}

export interface ExtractedAudioResult {
  metadata: AudioModel.audioMetadata;
  extra: ExtractedExtraMetadata;
  pictures: Picture[];
  extractor: "taglib" | "taglib+ffprobe" | "ffprobe";
}

export interface ExtractAudioOptions {
  includeCover?: boolean;
  originalFilename?: string;
}

let taglibPromise: Promise<TagLib> | null = null;

async function getTagLib(): Promise<TagLib> {
  if (!taglibPromise) {
    taglibPromise = TagLib.initialize().catch((error) => {
      taglibPromise = null;
      throw error;
    });
  }
  return await taglibPromise;
}

function cleanString(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function cleanStringArray(values: readonly string[] | undefined): string[] {
  if (!values || values.length === 0) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const cleaned = cleanString(raw);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }
  return result;
}

function buildCaseInsensitivePropMap(
  props: Record<string, string[] | undefined>,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [key, values] of Object.entries(props)) {
    if (!values || values.length === 0) continue;
    const normalizedKey = key.trim().toUpperCase();
    const cleaned = cleanStringArray(values);
    if (cleaned.length === 0) continue;
    const existing = map.get(normalizedKey);
    if (existing) {
      map.set(normalizedKey, cleanStringArray([...existing, ...cleaned]));
    } else {
      map.set(normalizedKey, cleaned);
    }
  }
  return map;
}

function getPropValues(
  propMap: Map<string, string[]>,
  ...keys: string[]
): string[] {
  for (const key of keys) {
    const found = propMap.get(key.toUpperCase());
    if (found && found.length > 0) return found;
  }
  return [];
}

function getFirstProp(
  propMap: Map<string, string[]>,
  ...keys: string[]
): string | undefined {
  return getPropValues(propMap, ...keys)[0];
}

function parseIntPair(
  raw: string | undefined,
): { number?: number; total?: number } {
  if (!raw) return {};
  const parts = raw.split("/");
  const num = Number.parseInt(parts[0]?.trim() ?? "", 10);
  const total = parts[1] ? Number.parseInt(parts[1].trim(), 10) : Number.NaN;
  return {
    number: Number.isFinite(num) && num > 0 ? num : undefined,
    total: Number.isFinite(total) && total > 0 ? total : undefined,
  };
}

function parseYear(
  numericYear: number | undefined,
  ...dateCandidates: Array<string | undefined>
): number | undefined {
  if (numericYear && Number.isFinite(numericYear) && numericYear > 0) {
    return Math.trunc(numericYear);
  }
  for (const candidate of dateCandidates) {
    if (!candidate) continue;
    const match = candidate.match(/\b(1\d{3}|2\d{3})\b/);
    if (match) {
      const parsed = Number.parseInt(match[1], 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  return undefined;
}

function parseFloatValue(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const match = raw.match(/[-+]?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const parsed = Number.parseFloat(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBooleanFlag(raw: string | undefined): boolean | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  return undefined;
}

function splitGenres(values: string[]): string[] {
  const expanded: string[] = [];
  for (const value of values) {
    for (const part of value.split(/[;|]/)) {
      const cleaned = cleanString(part);
      if (cleaned) expanded.push(cleaned);
    }
  }
  return cleanStringArray(expanded);
}

function splitArtistString(value: string): string[] {
  const parts = value.split(
    /\s*;\s*|\s+\/\s+|\s+(?:feat\.?|ft\.?|featuring)\s+/i,
  );
  return cleanStringArray(parts);
}

export function resolveArtistList(
  explicitArtists: string[],
  rawArtist: string | undefined,
): string[] {
  if (explicitArtists.length > 1) {
    return cleanStringArray(explicitArtists);
  }
  const single = explicitArtists[0] ?? rawArtist;
  if (!single) return [];
  const split = splitArtistString(single);
  return split.length > 0 ? split : [single];
}

function titleFromFilename(filename: string | undefined): string | undefined {
  if (!filename) return undefined;
  const base = basename(filename, extname(filename)).trim();
  if (!base) return undefined;
  const withoutTrackPrefix = base.replace(/^\d{1,3}\s*[-._)]\s*/, "").trim();
  return withoutTrackPrefix || base;
}

function sortPicturesFrontFirst(pictures: Picture[]): Picture[] {
  if (pictures.length <= 1) return pictures;
  return [...pictures].sort((a, b) => {
    const aFront = a.type === "FrontCover" ? 0 : 1;
    const bFront = b.type === "FrontCover" ? 0 : 1;
    return aFront - bFront;
  });
}

function pruneUndefined<T extends object>(obj: T): T {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0
    ) {
      continue;
    }
    cleaned[key] = value;
  }
  return cleaned as T;
}

interface FfprobeOutput {
  format?: {
    format_name?: string;
    duration?: string;
    bit_rate?: string;
    tags?: Record<string, string>;
  };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    sample_rate?: string;
    channels?: number;
    bit_rate?: string;
    bits_per_sample?: number;
    bits_per_raw_sample?: string;
    duration?: string;
    tags?: Record<string, string>;
  }>;
}

async function probeWithFfprobe(
  filePath: string,
): Promise<{
  metadata: AudioModel.audioMetadata;
  extra: ExtractedExtraMetadata;
} | null> {
  try {
    const proc = Bun.spawn(
      [
        "ffprobe",
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        filePath,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    const [exitCode, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
    ]);

    if (exitCode !== 0 || !stdout.trim()) return null;

    const parsed = JSON.parse(stdout) as FfprobeOutput;
    const format = parsed.format;
    const audioStream = parsed.streams?.find((s) => s.codec_type === "audio");

    const mergedTags: Record<string, string[]> = {};
    for (const source of [format?.tags, audioStream?.tags]) {
      if (!source) continue;
      for (const [k, v] of Object.entries(source)) {
        if (typeof v !== "string" || !v.trim()) continue;
        const upper = k.toUpperCase();
        mergedTags[upper] = [...(mergedTags[upper] ?? []), v];
      }
    }
    const propMap = buildCaseInsensitivePropMap(mergedTags);

    const durationRaw = audioStream?.duration ?? format?.duration;
    const duration = durationRaw ? Number.parseFloat(durationRaw) : Number.NaN;

    const bitrateRaw = audioStream?.bit_rate ?? format?.bit_rate;
    const bitrate = bitrateRaw ? Number.parseFloat(bitrateRaw) : Number.NaN;

    const sampleRateRaw = audioStream?.sample_rate;
    const sampleRate = sampleRateRaw
      ? Number.parseInt(sampleRateRaw, 10)
      : Number.NaN;

    const rawBitDepth = audioStream?.bits_per_raw_sample
      ? Number.parseInt(audioStream.bits_per_raw_sample, 10)
      : audioStream?.bits_per_sample ?? 0;

    const genreValues = splitGenres(getPropValues(propMap, "GENRE"));
    const releaseDate = getFirstProp(propMap, "DATE", "RELEASEDATE");
    const year = parseYear(
      undefined,
      getFirstProp(propMap, "YEAR"),
      releaseDate,
    );
    const trackPair = parseIntPair(getFirstProp(propMap, "TRACK", "TRACKNUMBER"));
    const discPair = parseIntPair(getFirstProp(propMap, "DISC", "DISCNUMBER"));

    const codec = cleanString(audioStream?.codec_name)?.toUpperCase();
    const isLossless = codec
      ? ["FLAC", "ALAC", "WAVPACK", "APE", "PCM_S16LE", "PCM_S24LE", "PCM_S32LE", "PCM_F32LE"].some(
          (c) => codec.startsWith(c),
        )
      : undefined;

    const rawArtist = getFirstProp(propMap, "ARTIST");
    const artists = resolveArtistList(
      getPropValues(propMap, "ARTISTS", "ARTIST"),
      rawArtist,
    );
    const compilation = parseBooleanFlag(getFirstProp(propMap, "COMPILATION"));
    const albumArtist =
      getFirstProp(propMap, "ALBUM_ARTIST", "ALBUMARTIST") ??
      (compilation ? "Various Artists" : undefined);
    const replayGain = pruneUndefined<AudioModel.replayGain>({
      trackGain: parseFloatValue(getFirstProp(propMap, "REPLAYGAIN_TRACK_GAIN")),
      trackPeak: parseFloatValue(getFirstProp(propMap, "REPLAYGAIN_TRACK_PEAK")),
      albumGain: parseFloatValue(getFirstProp(propMap, "REPLAYGAIN_ALBUM_GAIN")),
      albumPeak: parseFloatValue(getFirstProp(propMap, "REPLAYGAIN_ALBUM_PEAK")),
    });
    const lyrics = getFirstProp(propMap, "LYRICS", "UNSYNCEDLYRICS");

    const metadata: AudioModel.audioMetadata = {
      title: getFirstProp(propMap, "TITLE"),
      artist: rawArtist,
      albumArtist,
      artists: artists.length > 0 ? artists : undefined,
      album: getFirstProp(propMap, "ALBUM"),
      trackNumber: trackPair.number,
      totalTracks: trackPair.total,
      discNumber: discPair.number,
      totalDiscs: discPair.total,
      compilation,
      isrc: normalizeIsrc(getPropValues(propMap, "ISRC", "TSRC")) ?? undefined,
      year,
      genre: genreValues.length > 0 ? genreValues : undefined,
      duration: Number.isFinite(duration) && duration > 0 ? duration : undefined,
      bitrate: Number.isFinite(bitrate) && bitrate > 0 ? bitrate : undefined,
      sampleRate:
        Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : undefined,
      bitDepth:
        Number.isFinite(rawBitDepth) && rawBitDepth > 0
          ? rawBitDepth
          : undefined,
      channels:
        audioStream?.channels && audioStream.channels > 0
          ? audioStream.channels
          : undefined,
      format: cleanString(format?.format_name?.split(",")[0])?.toUpperCase(),
      codec,
      lossless: isLossless,
      replayGain: Object.keys(replayGain).length > 0 ? replayGain : undefined,
      lyrics,
    };

    const extra = pruneUndefined<ExtractedExtraMetadata>({
      releaseDate,
      bpm: parseFloatValue(getFirstProp(propMap, "BPM", "TBPM")),
      composer: getPropValues(propMap, "COMPOSER"),
      label: getFirstProp(propMap, "PUBLISHER", "LABEL"),
      copyright: getFirstProp(propMap, "COPYRIGHT"),
      upc: getFirstProp(propMap, "UPC", "BARCODE"),
      comment: getFirstProp(propMap, "COMMENT"),
    });

    return { metadata, extra };
  } catch (error) {
    logger.warn(
      `ffprobe fallback failed: ${error instanceof Error ? error.message : String(error)}`,
      { context: "METADATA" },
    );
    return null;
  }
}

function mergeMetadata(
  primary: AudioModel.audioMetadata,
  fallback: AudioModel.audioMetadata,
): AudioModel.audioMetadata {
  return {
    title: primary.title ?? fallback.title,
    artist: primary.artist ?? fallback.artist,
    albumArtist: primary.albumArtist ?? fallback.albumArtist,
    artists:
      primary.artists && primary.artists.length > 0
        ? primary.artists
        : fallback.artists,
    album: primary.album ?? fallback.album,
    trackNumber: primary.trackNumber ?? fallback.trackNumber,
    totalTracks: primary.totalTracks ?? fallback.totalTracks,
    discNumber: primary.discNumber ?? fallback.discNumber,
    totalDiscs: primary.totalDiscs ?? fallback.totalDiscs,
    compilation: primary.compilation ?? fallback.compilation,
    isrc: primary.isrc ?? fallback.isrc,
    year: primary.year ?? fallback.year,
    genre:
      primary.genre && primary.genre.length > 0
        ? primary.genre
        : fallback.genre,
    duration: primary.duration ?? fallback.duration,
    bitrate: primary.bitrate ?? fallback.bitrate,
    sampleRate: primary.sampleRate ?? fallback.sampleRate,
    bitDepth: primary.bitDepth ?? fallback.bitDepth,
    channels: primary.channels ?? fallback.channels,
    format: primary.format ?? fallback.format,
    codec: primary.codec ?? fallback.codec,
    lossless: primary.lossless ?? fallback.lossless,
    replayGain: primary.replayGain ?? fallback.replayGain,
    lyrics: primary.lyrics ?? fallback.lyrics,
  };
}

function mergeExtra(
  primary: ExtractedExtraMetadata,
  fallback: ExtractedExtraMetadata,
): ExtractedExtraMetadata {
  return pruneUndefined<ExtractedExtraMetadata>({
    ...fallback,
    ...primary,
    artists:
      primary.artists && primary.artists.length > 0
        ? primary.artists
        : fallback.artists,
    albumArtists:
      primary.albumArtists && primary.albumArtists.length > 0
        ? primary.albumArtists
        : fallback.albumArtists,
    composer:
      primary.composer && primary.composer.length > 0
        ? primary.composer
        : fallback.composer,
    replayGain: primary.replayGain ?? fallback.replayGain,
    musicbrainz: primary.musicbrainz ?? fallback.musicbrainz,
  });
}

export async function extractAudioMetadata(
  filePath: string,
  options?: ExtractAudioOptions,
): Promise<ExtractedAudioResult | null> {
  const includeCover = options?.includeCover ?? false;
  let taglibResult: {
    metadata: AudioModel.audioMetadata;
    extra: ExtractedExtraMetadata;
    pictures: Picture[];
  } | null = null;

  try {
    const taglib = await getTagLib();
    const file = await taglib.open(filePath);
    try {
      const tag = file.tag();
      const props = file.audioProperties();
      const propMap = buildCaseInsensitivePropMap(file.properties());

      const rawTitle = cleanString(tag.title) ?? getFirstProp(propMap, "TITLE");
      const rawArtist =
        cleanString(tag.artist) ?? getFirstProp(propMap, "ARTIST");
      const rawAlbum = cleanString(tag.album) ?? getFirstProp(propMap, "ALBUM");

      const artists = resolveArtistList(
        getPropValues(propMap, "ARTISTS", "ARTIST"),
        rawArtist,
      );
      const albumArtists = getPropValues(
        propMap,
        "ALBUMARTISTS",
        "ALBUMARTIST",
        "ALBUM_ARTIST",
        "ALBUM ARTIST",
      );
      const compilation = parseBooleanFlag(
        getFirstProp(propMap, "COMPILATION", "TCMP"),
      );
      const albumArtist =
        albumArtists[0] ?? (compilation ? "Various Artists" : undefined);

      const tagGenre = cleanString(tag.genre);
      const genres = splitGenres([
        ...getPropValues(propMap, "GENRE"),
        ...(tagGenre ? [tagGenre] : []),
      ]);

      const releaseDate = getFirstProp(
        propMap,
        "DATE",
        "RELEASEDATE",
        "ORIGINALDATE",
      );
      const originalDate = getFirstProp(propMap, "ORIGINALDATE", "ORIGINALYEAR");
      const year = parseYear(
        tag.year && tag.year > 0 ? tag.year : undefined,
        getFirstProp(propMap, "YEAR"),
        releaseDate,
        originalDate,
      );

      const trackPair = parseIntPair(
        getFirstProp(propMap, "TRACKNUMBER", "TRACK"),
      );
      const trackNumber =
        (tag.track && tag.track > 0 ? tag.track : undefined) ?? trackPair.number;
      const totalTracks =
        parseIntPair(getFirstProp(propMap, "TRACKTOTAL", "TOTALTRACKS"))
          .number ?? trackPair.total;

      const discPair = parseIntPair(getFirstProp(propMap, "DISCNUMBER", "DISC"));
      const discNumber = discPair.number;
      const totalDiscs =
        parseIntPair(getFirstProp(propMap, "DISCTOTAL", "TOTALDISCS"))
          .number ?? discPair.total;

      const isrc =
        normalizeIsrc(getPropValues(propMap, "ISRC", "TSRC")) ?? undefined;

      const replayGain = pruneUndefined<ExtractedReplayGain>({
        trackGain: parseFloatValue(
          getFirstProp(propMap, "REPLAYGAIN_TRACK_GAIN"),
        ),
        trackPeak: parseFloatValue(
          getFirstProp(propMap, "REPLAYGAIN_TRACK_PEAK"),
        ),
        albumGain: parseFloatValue(
          getFirstProp(propMap, "REPLAYGAIN_ALBUM_GAIN"),
        ),
        albumPeak: parseFloatValue(
          getFirstProp(propMap, "REPLAYGAIN_ALBUM_PEAK"),
        ),
        r128TrackGain: parseFloatValue(
          getFirstProp(propMap, "R128_TRACK_GAIN"),
        ),
        r128AlbumGain: parseFloatValue(
          getFirstProp(propMap, "R128_ALBUM_GAIN"),
        ),
      });

      const musicbrainz = pruneUndefined<ExtractedMusicBrainz>({
        trackId: getFirstProp(
          propMap,
          "MUSICBRAINZ_TRACKID",
          "MUSICBRAINZ_RELEASETRACKID",
        ),
        releaseId: getFirstProp(propMap, "MUSICBRAINZ_ALBUMID"),
        artistId: getFirstProp(propMap, "MUSICBRAINZ_ARTISTID"),
        releaseGroupId: getFirstProp(propMap, "MUSICBRAINZ_RELEASEGROUPID"),
      });

      let lyrics: string | undefined;
      try {
        const unsynced = file.getLyrics();
        lyrics = cleanString(unsynced?.[0]?.text);
      } catch {
      }
      if (!lyrics) {
        lyrics = getFirstProp(propMap, "LYRICS", "UNSYNCEDLYRICS");
      }

      const advisoryRaw = getFirstProp(propMap, "ITUNESADVISORY", "ADVISORY");
      const explicit =
        advisoryRaw === "1" ||
        advisoryRaw?.toLowerCase() === "explicit"
          ? true
          : advisoryRaw === "2" || advisoryRaw?.toLowerCase() === "clean"
            ? false
            : undefined;

      const duration =
        props?.durationMs && props.durationMs > 0
          ? props.durationMs / 1000
          : props?.duration && props.duration > 0
            ? props.duration
            : undefined;

      const bitrate =
        props?.bitrate && props.bitrate > 0 ? props.bitrate * 1000 : undefined;
      const sampleRate =
        props?.sampleRate && props.sampleRate > 0
          ? props.sampleRate
          : undefined;
      const bitDepth =
        props?.bitsPerSample && props.bitsPerSample > 0
          ? props.bitsPerSample
          : undefined;
      const channels =
        props?.channels && props.channels > 0 ? props.channels : undefined;

      const containerFormat =
        props?.containerFormat && props.containerFormat !== "unknown"
          ? props.containerFormat
          : file.getFormat() !== "unknown"
            ? file.getFormat()
            : undefined;
      const codec =
        props?.codec && props.codec !== "unknown" ? props.codec : undefined;

      const pictures = includeCover
        ? sortPicturesFrontFirst(file.getPictures() ?? [])
        : [];

      const coreReplayGain = pruneUndefined<AudioModel.replayGain>({
        trackGain: replayGain.trackGain,
        trackPeak: replayGain.trackPeak,
        albumGain: replayGain.albumGain,
        albumPeak: replayGain.albumPeak,
      });

      const metadata: AudioModel.audioMetadata = {
        title: rawTitle,
        artist: rawArtist,
        albumArtist,
        artists: artists.length > 0 ? artists : undefined,
        album: rawAlbum,
        trackNumber,
        totalTracks,
        discNumber,
        totalDiscs,
        compilation,
        isrc,
        year,
        genre: genres.length > 0 ? genres : undefined,
        duration,
        bitrate,
        sampleRate,
        bitDepth,
        channels,
        format: containerFormat,
        codec,
        lossless: props?.isLossless,
        replayGain:
          Object.keys(coreReplayGain).length > 0 ? coreReplayGain : undefined,
        lyrics,
      };

      const extra = pruneUndefined<ExtractedExtraMetadata>({
        albumArtists: albumArtists.length > 0 ? albumArtists : undefined,
        releaseDate,
        originalDate,
        bpm: parseFloatValue(getFirstProp(propMap, "BPM", "TBPM")),
        composer: getPropValues(propMap, "COMPOSER"),
        label: getFirstProp(propMap, "LABEL", "PUBLISHER", "ORGANIZATION"),
        copyright: getFirstProp(propMap, "COPYRIGHT"),
        upc: getFirstProp(propMap, "UPC", "BARCODE"),
        explicit,
        comment: cleanString(tag.comment) ?? getFirstProp(propMap, "COMMENT"),
        replayGain:
          replayGain.r128TrackGain !== undefined ||
          replayGain.r128AlbumGain !== undefined
            ? pruneUndefined<ExtractedReplayGain>({
                r128TrackGain: replayGain.r128TrackGain,
                r128AlbumGain: replayGain.r128AlbumGain,
              })
            : undefined,
        musicbrainz:
          Object.keys(musicbrainz).length > 0 ? musicbrainz : undefined,
      });

      taglibResult = { metadata, extra, pictures };
    } finally {
      file.dispose();
    }
  } catch (error) {
    logger.warn(
      `TagLib extraction failed for ${basename(filePath)}, falling back to ffprobe: ${error instanceof Error ? error.message : String(error)}`,
      { context: "METADATA" },
    );
  }

  const needsFfprobeFallback =
    !taglibResult ||
    !taglibResult.metadata.duration ||
    !taglibResult.metadata.bitrate ||
    !taglibResult.metadata.sampleRate;

  let finalMetadata: AudioModel.audioMetadata;
  let finalExtra: ExtractedExtraMetadata;
  let extractor: ExtractedAudioResult["extractor"] = "taglib";

  if (needsFfprobeFallback) {
    const probed = await probeWithFfprobe(filePath);
    if (taglibResult && probed) {
      finalMetadata = mergeMetadata(taglibResult.metadata, probed.metadata);
      finalExtra = mergeExtra(taglibResult.extra, probed.extra);
      extractor = "taglib+ffprobe";
    } else if (taglibResult) {
      finalMetadata = taglibResult.metadata;
      finalExtra = taglibResult.extra;
    } else if (probed) {
      finalMetadata = probed.metadata;
      finalExtra = probed.extra;
      extractor = "ffprobe";
    } else {
      return null;
    }
  } else {
    finalMetadata = taglibResult!.metadata;
    finalExtra = taglibResult!.extra;
  }

  if (!finalMetadata.title) {
    finalMetadata.title = titleFromFilename(options?.originalFilename);
  }

  return {
    metadata: finalMetadata,
    extra: finalExtra,
    pictures: taglibResult?.pictures ?? [],
    extractor,
  };
}

export async function extractAndStoreCoverArt(
  filePath: string,
  preExtractedPictures?: Picture[],
): Promise<string | null> {
  let pictures = preExtractedPictures;

  if (pictures === undefined) {
    const extracted = await extractAudioMetadata(filePath, {
      includeCover: true,
    });
    pictures = extracted?.pictures ?? [];
  }

  for (const picture of pictures) {
    if (!picture.data || picture.data.byteLength === 0) continue;
    const storedKey = await processAndStoreCoverArt(picture.data);
    if (storedKey) return storedKey;
  }

  const fallbackBytes = await extractCoverWithFfmpeg(filePath);
  if (!fallbackBytes) return null;

  return await processAndStoreCoverArt(fallbackBytes);
}

export function serializeExtraMetadata(
  extra: ExtractedExtraMetadata | undefined,
): Record<string, unknown> | null {
  if (!extra || Object.keys(extra).length === 0) return null;
  return extra as Record<string, unknown>;
}

export async function inspectRawTagLib(filePath: string): Promise<{
  format: string;
  properties: Record<string, string[] | undefined>;
  audioProperties: ReturnType<
    Awaited<ReturnType<TagLib["open"]>>["audioProperties"]
  >;
  pictureCount: number;
  pictures: Array<{
    type: string;
    mimeType: string;
    bytes: number;
    description?: string;
  }>;
}> {
  const taglib = await getTagLib();
  const file = await taglib.open(filePath);
  try {
    const pictures = file.getPictures() ?? [];
    return {
      format: file.getFormat(),
      properties: file.properties(),
      audioProperties: file.audioProperties(),
      pictureCount: pictures.length,
      pictures: pictures.map((p) => ({
        type: p.type,
        mimeType: p.mimeType,
        bytes: p.data.byteLength,
        description: p.description,
      })),
    };
  } finally {
    file.dispose();
  }
}
