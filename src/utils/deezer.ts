import { normalizeIsrc } from "./isrc";

const DEEZER_API_URL = "https://api.deezer.com/search";
const DEEZER_API_TIMEOUT_MS = 10_000;
const DEEZER_SEARCH_LIMIT = 10;

interface DeezerSearchArtist {
  name?: string;
}

interface DeezerSearchTrack {
  title?: string;
  title_short?: string;
  artist?: DeezerSearchArtist;
  isrc?: string;
}

interface DeezerSearchResponse {
  data?: DeezerSearchTrack[];
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenOverlapScore(a: string, b: string): number {
  if (!a || !b) return 0;

  const aTokens = new Set(a.split(" ").filter(Boolean));
  const bTokens = new Set(b.split(" ").filter(Boolean));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap += 1;
  }

  return overlap;
}

function scoreTrackCandidate(
  track: DeezerSearchTrack,
  titleNorm: string,
  artistNorm: string,
): number {
  const trackTitleNorm = normalizeText(track.title || track.title_short);
  const trackArtistNorm = normalizeText(track.artist?.name);

  let score = 0;

  if (trackTitleNorm === titleNorm) {
    score += 60;
  } else if (
    trackTitleNorm.includes(titleNorm) ||
    titleNorm.includes(trackTitleNorm)
  ) {
    score += 30;
  } else {
    score += tokenOverlapScore(trackTitleNorm, titleNorm) * 5;
  }

  if (artistNorm) {
    if (trackArtistNorm === artistNorm) {
      score += 40;
    } else if (
      trackArtistNorm.includes(artistNorm) ||
      artistNorm.includes(trackArtistNorm)
    ) {
      score += 20;
    } else {
      score += tokenOverlapScore(trackArtistNorm, artistNorm) * 4;
    }
  }

  return score;
}

export async function getIsrcFromDeezerSearch(input: {
  title?: string | null;
  artist?: string | null;
  signal?: AbortSignal;
}): Promise<string | null> {
  const title = input.title?.trim();
  if (!title) return null;

  const artist = input.artist?.trim() ?? "";
  const query = `${title} ${artist}`.trim();
  const titleNorm = normalizeText(title);
  const artistNorm = normalizeText(artist);

  const url = `${DEEZER_API_URL}?q=${encodeURIComponent(query)}&limit=${DEEZER_SEARCH_LIMIT}`;

  try {
    const resp = await fetch(url, {
      signal: input.signal ?? AbortSignal.timeout(DEEZER_API_TIMEOUT_MS),
    });
    if (!resp.ok) return null;

    const body: DeezerSearchResponse = await resp.json();
    const tracks = body.data ?? [];

    let bestScore = -1;
    let bestIsrc: string | null = null;

    for (const track of tracks) {
      const isrc = normalizeIsrc(track.isrc);
      if (!isrc) continue;

      const score = scoreTrackCandidate(track, titleNorm, artistNorm);
      if (score > bestScore) {
        bestScore = score;
        bestIsrc = isrc;
      }
    }

    const threshold = artistNorm ? 20 : 15;
    if (bestScore < threshold) return null;

    return bestIsrc;
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      return null;
    }
    return null;
  }
}
