import { existsSync, unlinkSync } from "fs";
import { normalizeIsrc } from "./isrc";

export const TIDAL_PROXY_APIS = [
  "https://tidal-api.binimum.org",
  "https://tidal.kinoplus.online",
  "https://triton.squid.wtf",
  "https://voge.qqdl.site",
  "https://maus.qqdl.site",
  "https://hund.qqdl.site",
  "https://katze.qqdl.site",
  "https://wolf.qqdl.site",
  "https://hifi-one.spotisaver.net",
  "https://hifi-two.spotisaver.net",
];

const TIDAL_MAX_RETRIES = 2;
const TIDAL_RETRY_DELAY_MS = 500;
const TIDAL_API_TIMEOUT_MS = 25_000;

export interface TidalDownloadInfo {
  url: string;
  bitDepth: number;
  sampleRate: number;
}

interface TidalV1Item {
  OriginalTrackUrl: string;
}

interface TidalV2Response {
  version?: string;
  data?: {
    assetPresentation?: string;
    audioMode?: string;
    audioQuality?: string;
    manifestMimeType?: string;
    manifest?: string;
    bitDepth?: number;
    sampleRate?: number;
  };
}

interface TidalInfoResponse {
  isrc?: string;
  data?: {
    isrc?: string;
  };
}

interface TidalBTSManifest {
  mimeType?: string;
  codecs?: string;
  encryptionType?: string;
  urls?: string[];
}

export type TidalResourceType = "track" | "album" | "playlist";

export interface TidalResourceRef {
  type: TidalResourceType;
  id: string;
}

interface TidalCollectionItem {
  id?: number;
  item?: {
    id?: number;
  };
}

interface TidalAlbumResponse {
  data?: {
    title?: string;
    numberOfTracks?: number;
    items?: TidalCollectionItem[];
  };
}

interface TidalPlaylistResponse {
  playlist?: {
    title?: string;
    numberOfTracks?: number;
  };
  items?: TidalCollectionItem[];
}

interface TidalCollectionPage {
  title: string;
  totalTracks: number;
  trackIds: number[];
}

export interface TidalCollectionInfo {
  type: Exclude<TidalResourceType, "track">;
  id: string;
  title: string;
  trackIds: number[];
}

interface TidalSearchTrack {
  id?: number;
  title?: string;
  url?: string;
  artist?: {
    name?: string;
  };
  artists?: Array<{
    name?: string;
    type?: string;
  }>;
  album?: {
    cover?: string;
  };
}

interface TidalSearchResponse {
  data?: {
    items?: TidalSearchTrack[];
    tracks?: {
      items?: TidalSearchTrack[];
    };
  };
}

export interface TidalSearchResult {
  trackId: string;
  title: string;
  artist: string;
  thumbnail: string;
  url: string;
}

const TIDAL_DEFAULT_SEARCH_LIMIT = 10;
const TIDAL_MAX_SEARCH_LIMIT = 50;

async function fetchTrackIsrcFromProxy(
  api: string,
  trackId: number,
  signal?: AbortSignal,
): Promise<string | null> {
  let lastErr: Error = new Error("No attempts made");
  let retryDelay = TIDAL_RETRY_DELAY_MS;

  for (let attempt = 0; attempt <= TIDAL_MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new Error("Download cancelled");

    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, retryDelay));
      retryDelay *= 2;
    }

    const reqUrl = `${api}/info/?id=${trackId}`;

    try {
      const resp = await fetch(reqUrl, {
        signal: signal ?? AbortSignal.timeout(TIDAL_API_TIMEOUT_MS),
      });

      if (resp.status === 429) {
        await resp.body?.cancel();
        lastErr = new Error("Rate limited");
        retryDelay = 2000;
        continue;
      }

      if (resp.status >= 500) {
        await resp.body?.cancel();
        lastErr = new Error(`HTTP ${resp.status}`);
        continue;
      }

      if (!resp.ok) {
        await resp.body?.cancel();
        throw new Error(`HTTP ${resp.status}`);
      }

      const body: TidalInfoResponse = await resp.json();
      return normalizeIsrc(body.data?.isrc ?? body.isrc);
    } catch (e) {
      const err = e as Error;
      if (err.name === "AbortError") {
        throw err;
      }

      lastErr = err;
      const msg = err.message.toLowerCase();
      if (
        msg.includes("timeout") ||
        msg.includes("reset") ||
        msg.includes("econnrefused") ||
        msg.includes("eof") ||
        msg.includes("network") ||
        msg.includes("fetch")
      ) {
        continue;
      }
      break;
    }
  }

  throw lastErr;
}

export async function getTidalTrackIsrc(
  trackId: number,
  signal?: AbortSignal,
): Promise<string | null> {
  const attempts = TIDAL_PROXY_APIS.map(async (api) => {
    const isrc = await fetchTrackIsrcFromProxy(api, trackId, signal);
    if (!isrc) {
      throw new Error("ISRC not found");
    }
    return isrc;
  });

  try {
    return await Promise.any(attempts);
  } catch {
    return null;
  }
}

export function parseTidalResourceUrl(url: string): TidalResourceRef {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }

  const validHosts = ["tidal.com", "listen.tidal.com", "www.tidal.com"];
  if (!validHosts.includes(parsed.hostname)) {
    throw new Error("Not a Tidal URL");
  }

  const parts = parsed.pathname
    .replace(/^\//, "")
    .split("/")
    .filter((part) => part.length > 0);
  const normalized = parts[0] === "browse" ? parts.slice(1) : parts;

  if (normalized.length < 2) {
    throw new Error(
      "Could not find resource ID in Tidal URL. Expected format: tidal.com/browse/{track|album|playlist}/<id>",
    );
  }

  const type = normalized[0] as TidalResourceType;
  if (type !== "track" && type !== "album" && type !== "playlist") {
    throw new Error(
      "Unsupported Tidal resource. Supported: track, album, playlist",
    );
  }

  const rawId = normalized[1];
  if (!rawId) {
    throw new Error("Missing Tidal resource ID in URL");
  }

  if (type === "track" || type === "album") {
    const numericId = parseInt(rawId, 10);
    if (!Number.isFinite(numericId) || numericId <= 0) {
      throw new Error(`Invalid Tidal ${type} ID in URL`);
    }
    return { type, id: String(numericId) };
  }

  return { type, id: rawId };
}

export function parseTidalUrl(url: string): number {
  const resource = parseTidalResourceUrl(url);
  if (resource.type !== "track") {
    throw new Error(
      "Expected a Tidal track URL. Album and playlist URLs must be handled as collections.",
    );
  }

  const id = parseInt(resource.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error("Invalid Tidal track ID in URL");
  }

  return id;
}

async function fetchFromProxy(
  api: string,
  trackId: number,
  quality: string,
  signal?: AbortSignal,
): Promise<TidalDownloadInfo> {
  let lastErr: Error = new Error("No attempts made");
  let retryDelay = TIDAL_RETRY_DELAY_MS;

  for (let attempt = 0; attempt <= TIDAL_MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new Error("Download cancelled");

    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, retryDelay));
      retryDelay *= 2;
    }

    const reqUrl = `${api}/track/?id=${trackId}&quality=${quality}`;

    try {
      const resp = await fetch(reqUrl, {
        signal: signal ?? AbortSignal.timeout(TIDAL_API_TIMEOUT_MS),
      });

      if (resp.status === 429) {
        await resp.body?.cancel();
        lastErr = new Error("Rate limited");
        retryDelay = 2000;
        continue;
      }

      if (resp.status >= 500) {
        await resp.body?.cancel();
        lastErr = new Error(`HTTP ${resp.status}`);
        continue;
      }

      if (!resp.ok) {
        await resp.body?.cancel();
        throw new Error(`HTTP ${resp.status}`);
      }

      const body = await resp.text();

      try {
        const v2: TidalV2Response = JSON.parse(body);
        if (v2.data?.manifest) {
          if (v2.data.assetPresentation === "PREVIEW") {
            throw new Error("API returned PREVIEW instead of FULL");
          }
          return {
            url: `MANIFEST:${v2.data.manifest}`,
            bitDepth: v2.data.bitDepth ?? 16,
            sampleRate: v2.data.sampleRate ?? 44100,
          };
        }
      } catch (e) {
        if ((e as Error).message.includes("PREVIEW")) throw e;
      }

      try {
        const v1: TidalV1Item[] = JSON.parse(body);
        if (Array.isArray(v1)) {
          for (const item of v1) {
            if (item.OriginalTrackUrl) {
              return {
                url: item.OriginalTrackUrl,
                bitDepth: 16,
                sampleRate: 44100,
              };
            }
          }
        }
      } catch {}

      throw new Error("No download URL or manifest in response");
    } catch (e) {
      const err = e as Error;
      if (err.name === "AbortError" || err.message.includes("PREVIEW")) {
        throw err;
      }
      lastErr = err;
      const msg = err.message.toLowerCase();
      if (
        msg.includes("timeout") ||
        msg.includes("reset") ||
        msg.includes("econnrefused") ||
        msg.includes("eof") ||
        msg.includes("network") ||
        msg.includes("fetch")
      ) {
        continue;
      }
      break;
    }
  }

  throw lastErr;
}

export async function getDownloadUrl(
  trackId: number,
  quality: string,
  signal?: AbortSignal,
): Promise<TidalDownloadInfo> {
  const results = await Promise.any(
    TIDAL_PROXY_APIS.map((api) =>
      fetchFromProxy(api, trackId, quality, signal),
    ),
  );
  return results;
}

function clampSearchLimit(limit: number): number {
  if (!Number.isFinite(limit)) return TIDAL_DEFAULT_SEARCH_LIMIT;
  return Math.max(1, Math.min(TIDAL_MAX_SEARCH_LIMIT, Math.floor(limit)));
}

function buildTidalImageUrl(imageId: string | undefined, size = 640): string {
  if (!imageId) return "";
  const safeSize = Math.max(64, Math.min(1280, size));
  return `https://resources.tidal.com/images/${imageId.replace(/-/g, "/")}/${safeSize}x${safeSize}.jpg`;
}

function getTrackArtistName(track: TidalSearchTrack): string {
  if (track.artist?.name) return track.artist.name;

  const mainArtist = track.artists?.find((artist) => artist.type === "MAIN");
  if (mainArtist?.name) return mainArtist.name;

  const firstArtist = track.artists?.find((artist) => !!artist.name);
  return firstArtist?.name ?? "Unknown Artist";
}

async function fetchSearchFromProxy(
  api: string,
  query: string,
  limit: number,
): Promise<TidalSearchResult[]> {
  let lastErr: Error = new Error("No attempts made");
  let retryDelay = TIDAL_RETRY_DELAY_MS;

  for (let attempt = 0; attempt <= TIDAL_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, retryDelay));
      retryDelay *= 2;
    }

    const reqUrl = `${api}/search/?s=${encodeURIComponent(query)}&limit=${limit}&offset=0`;

    try {
      const resp = await fetch(reqUrl, {
        signal: AbortSignal.timeout(TIDAL_API_TIMEOUT_MS),
      });

      if (resp.status === 429) {
        await resp.body?.cancel();
        lastErr = new Error("Rate limited");
        retryDelay = 2000;
        continue;
      }

      if (resp.status >= 500) {
        await resp.body?.cancel();
        lastErr = new Error(`HTTP ${resp.status}`);
        continue;
      }

      if (!resp.ok) {
        await resp.body?.cancel();
        throw new Error(`HTTP ${resp.status}`);
      }

      const body = await resp.text();
      const parsed: TidalSearchResponse = JSON.parse(body);
      const items =
        parsed.data?.tracks?.items ??
        (Array.isArray(parsed.data?.items) ? parsed.data.items : []);

      const results: TidalSearchResult[] = [];
      for (const item of items) {
        if (
          typeof item.id !== "number" ||
          !Number.isFinite(item.id) ||
          item.id <= 0
        ) {
          continue;
        }

        const trackId = String(item.id);
        results.push({
          trackId,
          title: item.title?.trim() || `Track ${trackId}`,
          artist: getTrackArtistName(item),
          thumbnail: buildTidalImageUrl(item.album?.cover),
          url: `https://tidal.com/browse/track/${trackId}`,
        });
      }

      return results;
    } catch (e) {
      const err = e as Error;
      if (err.name === "AbortError") {
        throw err;
      }

      lastErr = err;
      const msg = err.message.toLowerCase();
      if (
        msg.includes("timeout") ||
        msg.includes("reset") ||
        msg.includes("econnrefused") ||
        msg.includes("eof") ||
        msg.includes("network") ||
        msg.includes("fetch")
      ) {
        continue;
      }
      break;
    }
  }

  throw lastErr;
}

export async function searchTidalTracks(
  query: string,
  limit = TIDAL_DEFAULT_SEARCH_LIMIT,
): Promise<TidalSearchResult[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return [];

  const clampedLimit = clampSearchLimit(limit);
  const settled = await Promise.allSettled(
    TIDAL_PROXY_APIS.map((api) =>
      fetchSearchFromProxy(api, trimmedQuery, clampedLimit),
    ),
  );

  let fallback: TidalSearchResult[] | null = null;
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    const items = result.value;
    if (items.length > 0) return items;
    if (!fallback) fallback = items;
  }

  if (fallback) return fallback;
  throw new Error("Tidal search failed across all proxies");
}

function extractTrackIdsFromCollectionItems(
  items: TidalCollectionItem[] | undefined,
): number[] {
  if (!items || items.length === 0) return [];

  const ids: number[] = [];
  for (const entry of items) {
    const id = entry.item?.id ?? entry.id;
    if (typeof id === "number" && Number.isFinite(id) && id > 0) {
      ids.push(id);
    }
  }
  return ids;
}

async function fetchCollectionPageFromProxy(
  api: string,
  type: Exclude<TidalResourceType, "track">,
  id: string,
  limit: number,
  offset: number,
  signal?: AbortSignal,
): Promise<TidalCollectionPage> {
  let lastErr: Error = new Error("No attempts made");
  let retryDelay = TIDAL_RETRY_DELAY_MS;

  for (let attempt = 0; attempt <= TIDAL_MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new Error("Download cancelled");

    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, retryDelay));
      retryDelay *= 2;
    }

    const reqUrl = `${api}/${type}/?id=${encodeURIComponent(id)}&limit=${limit}&offset=${offset}`;

    try {
      const resp = await fetch(reqUrl, {
        signal: signal ?? AbortSignal.timeout(TIDAL_API_TIMEOUT_MS),
      });

      if (resp.status === 429) {
        await resp.body?.cancel();
        lastErr = new Error("Rate limited");
        retryDelay = 2000;
        continue;
      }

      if (resp.status >= 500) {
        await resp.body?.cancel();
        lastErr = new Error(`HTTP ${resp.status}`);
        continue;
      }

      if (!resp.ok) {
        await resp.body?.cancel();
        throw new Error(`HTTP ${resp.status}`);
      }

      const body = await resp.text();

      if (type === "album") {
        const parsed: TidalAlbumResponse = JSON.parse(body);
        const title = parsed.data?.title ?? "";
        const totalTracks = parsed.data?.numberOfTracks ?? 0;
        const trackIds = extractTrackIdsFromCollectionItems(parsed.data?.items);
        return { title, totalTracks, trackIds };
      }

      const parsed: TidalPlaylistResponse = JSON.parse(body);
      const title = parsed.playlist?.title ?? "";
      const totalTracks = parsed.playlist?.numberOfTracks ?? 0;
      const trackIds = extractTrackIdsFromCollectionItems(parsed.items);
      return { title, totalTracks, trackIds };
    } catch (e) {
      const err = e as Error;
      if (err.name === "AbortError") {
        throw err;
      }
      lastErr = err;
      const msg = err.message.toLowerCase();
      if (
        msg.includes("timeout") ||
        msg.includes("reset") ||
        msg.includes("econnrefused") ||
        msg.includes("eof") ||
        msg.includes("network") ||
        msg.includes("fetch")
      ) {
        continue;
      }
      break;
    }
  }

  throw lastErr;
}

async function fetchCollectionFromProxy(
  api: string,
  type: Exclude<TidalResourceType, "track">,
  id: string,
  signal?: AbortSignal,
): Promise<{ title: string; trackIds: number[] }> {
  const limit = 100;
  let offset = 0;
  let title = "";
  let totalTracks = 0;
  const trackIds: number[] = [];

  while (true) {
    const page = await fetchCollectionPageFromProxy(
      api,
      type,
      id,
      limit,
      offset,
      signal,
    );

    if (!title && page.title) title = page.title;
    if (page.totalTracks > 0) totalTracks = page.totalTracks;

    if (page.trackIds.length === 0) {
      break;
    }

    trackIds.push(...page.trackIds);
    offset += page.trackIds.length;

    if (totalTracks > 0 && offset >= totalTracks) {
      break;
    }

    if (page.trackIds.length < limit) {
      break;
    }
  }

  if (trackIds.length === 0) {
    throw new Error(`No tracks found for Tidal ${type} ${id}`);
  }

  return { title, trackIds };
}

export async function getTidalCollectionInfo(
  type: Exclude<TidalResourceType, "track">,
  id: string,
  signal?: AbortSignal,
): Promise<TidalCollectionInfo> {
  const first = await Promise.any(
    TIDAL_PROXY_APIS.map((api) =>
      fetchCollectionFromProxy(api, type, id, signal),
    ),
  );

  const seen = new Set<number>();
  const dedupedTrackIds: number[] = [];
  for (const trackId of first.trackIds) {
    if (seen.has(trackId)) continue;
    seen.add(trackId);
    dedupedTrackIds.push(trackId);
  }

  if (dedupedTrackIds.length === 0) {
    throw new Error(`No tracks found for Tidal ${type} ${id}`);
  }

  return {
    type,
    id,
    title: first.title || `Tidal ${type}`,
    trackIds: dedupedTrackIds,
  };
}

function parseBtsManifest(base64: string): string {
  const bytes = Buffer.from(base64, "base64");
  const manifest: TidalBTSManifest = JSON.parse(bytes.toString("utf8"));
  if (!manifest.urls || manifest.urls.length === 0) {
    throw new Error("No URLs in BTS manifest");
  }
  return manifest.urls[0];
}

function parseDashManifest(base64: string): {
  initUrl: string;
  mediaUrls: string[];
} {
  const bytes = Buffer.from(base64, "base64");
  const xml = bytes.toString("utf8");

  const initMatch = xml.match(/initialization="([^"]+)"/);
  const mediaMatch = xml.match(/media="([^"]+)"/);

  if (!initMatch || !mediaMatch) {
    throw new Error("No initialization or media template found in MPD");
  }

  const initUrl = initMatch[1].replace(/&amp;/g, "&");
  const mediaTemplate = mediaMatch[1].replace(/&amp;/g, "&");

  let segmentCount = 0;
  for (const match of xml.matchAll(/<S\s[^>]*d="(\d+)"(?:[^>]*r="(\d+)")?/g)) {
    const repeat = match[2] ? parseInt(match[2], 10) : 0;
    segmentCount += repeat + 1;
  }

  if (segmentCount === 0) {
    throw new Error("No segments found in MPD manifest");
  }

  const mediaUrls: string[] = [];
  for (let i = 1; i <= segmentCount; i++) {
    mediaUrls.push(mediaTemplate.replace("$Number$", String(i)));
  }

  return { initUrl, mediaUrls };
}

export type ManifestParseResult =
  | { type: "direct"; url: string }
  | { type: "dash"; initUrl: string; mediaUrls: string[] };

export interface TidalTrackInfo {
  id: number;
  title: string;
  artist: string;
  albumCoverUrl?: string;
}

export async function getTidalTrackInfo(
  trackId: number,
): Promise<TidalTrackInfo | null> {
  try {
    const tidalUrl = `https://tidal.com/browse/track/${trackId}`;
    const apiUrl = `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(tidalUrl)}`;
    const resp = await fetch(apiUrl, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) return null;

    const data = await resp.json();
    const entityKey = `TIDAL_SONG::${trackId}`;
    const entity = data.entitiesByUniqueId?.[entityKey];
    if (!entity?.title) return null;

    let thumbnailUrl: string | undefined = entity.thumbnailUrl;
    if (thumbnailUrl?.includes("resources.tidal.com/images/")) {
      thumbnailUrl = thumbnailUrl.replace(/\d+x\d+\.jpg$/, "1280x1280.jpg");
    }

    return {
      id: trackId,
      title: entity.title as string,
      artist: (entity.artistName as string) || "",
      albumCoverUrl: thumbnailUrl,
    };
  } catch {
    return null;
  }
}

export function parseManifest(manifestB64: string): ManifestParseResult {
  const bytes = Buffer.from(manifestB64, "base64");
  const content = bytes.toString("utf8");

  if (content.trimStart().startsWith("{")) {
    const directUrl = parseBtsManifest(manifestB64);
    return { type: "direct", url: directUrl };
  }

  const { initUrl, mediaUrls } = parseDashManifest(manifestB64);
  return { type: "dash", initUrl, mediaUrls };
}

export async function downloadDirectToFile(
  url: string,
  destPath: string,
  onProgress: (downloaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const resp = await fetch(url, { signal });
  if (!resp.ok) {
    throw new Error(`Download failed: HTTP ${resp.status}`);
  }

  const total = parseInt(resp.headers.get("content-length") ?? "0", 10);
  const body = resp.body;
  if (!body) throw new Error("Response body is empty");

  const writer = Bun.file(destPath).writer();
  const reader = body.getReader();
  let downloaded = 0;

  try {
    while (true) {
      if (signal?.aborted) throw new Error("Download cancelled");
      const { done, value } = await reader.read();
      if (done) break;
      writer.write(value);
      downloaded += value.byteLength;
      onProgress(downloaded, total);
    }
    await writer.flush();
    await writer.end();
  } catch (e) {
    await reader.cancel().catch(() => {});
    await Promise.resolve(writer.end()).catch(() => {});
    if (existsSync(destPath)) unlinkSync(destPath);
    throw e;
  }
}

export async function downloadDashToFile(
  initUrl: string,
  mediaUrls: string[],
  destPath: string,
  onProgress: (current: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const writer = Bun.file(destPath).writer();
  const total = mediaUrls.length + 1;

  try {
    if (signal?.aborted) throw new Error("Download cancelled");
    const initResp = await fetch(initUrl, { signal });
    if (!initResp.ok)
      throw new Error(`Init segment failed: HTTP ${initResp.status}`);
    writer.write(new Uint8Array(await initResp.arrayBuffer()));
    onProgress(1, total);

    for (let i = 0; i < mediaUrls.length; i++) {
      if (signal?.aborted) throw new Error("Download cancelled");
      const segResp = await fetch(mediaUrls[i], { signal });
      if (!segResp.ok)
        throw new Error(`Segment ${i + 1} failed: HTTP ${segResp.status}`);
      writer.write(new Uint8Array(await segResp.arrayBuffer()));
      onProgress(i + 2, total);
    }

    await writer.flush();
    await writer.end();
  } catch (e) {
    await Promise.resolve(writer.end()).catch(() => {});
    if (existsSync(destPath)) unlinkSync(destPath);
    throw e;
  }
}
