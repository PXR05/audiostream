import {
  cleanQueryTerm,
  normalizeForMatching,
  normalizeIsrc,
  parseTrackSearchTerms,
  scoreIsrcCandidate,
  stripAllParentheticals,
} from "./isrc";

const DEEZER_API_URL = "https://api.deezer.com/search";
const DEEZER_API_TIMEOUT_MS = 10_000;
const DEEZER_SEARCH_LIMIT = 15;
const DEEZER_HIGH_CONFIDENCE_SCORE = 85;

interface DeezerSearchArtist {
  name?: string;
}

interface DeezerSearchAlbum {
  title?: string;
}

interface DeezerSearchTrack {
  title?: string;
  title_short?: string;
  duration?: number;
  artist?: DeezerSearchArtist;
  album?: DeezerSearchAlbum;
  isrc?: string;
}

interface DeezerSearchResponse {
  data?: DeezerSearchTrack[];
  error?: {
    type?: string;
    message?: string;
    code?: number;
  };
}

function escapeDeezerQuote(value: string): string {
  return value.replace(/"/g, " ").replace(/\s+/g, " ").trim();
}

async function fetchDeezerTracks(
  query: string,
  signal?: AbortSignal,
): Promise<DeezerSearchTrack[] | null> {
  const url = `${DEEZER_API_URL}?q=${encodeURIComponent(query)}&limit=${DEEZER_SEARCH_LIMIT}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) return null;
    try {
      const fetchSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(DEEZER_API_TIMEOUT_MS)])
        : AbortSignal.timeout(DEEZER_API_TIMEOUT_MS);

      const resp = await fetch(url, { signal: fetchSignal });
      if (resp.status === 429 && attempt === 0) {
        await new Promise((r) => setTimeout(r, 1_500));
        continue;
      }
      if (!resp.ok) return null;

      const body = (await resp.json()) as DeezerSearchResponse;
      if (body.error?.code === 4 && attempt === 0) {
        // Deezer quota limit exceeded — brief backoff and retry once
        await new Promise((r) => setTimeout(r, 1_500));
        continue;
      }
      return body.data ?? [];
    } catch {
      return null;
    }
  }
  return null;
}

export async function getIsrcFromDeezerSearch(input: {
  title?: string | null;
  artist?: string | null;
  artists?: string[] | null;
  album?: string | null;
  duration?: number | null;
  signal?: AbortSignal;
}): Promise<string | null> {
  const parsed = parseTrackSearchTerms({
    title: input.title,
    artist: input.artist,
    artists: input.artists,
  });
  if (!parsed) return null;

  const targetAlbumNorm = normalizeForMatching(cleanQueryTerm(input.album));
  const queryAttempts: Array<{
    query: string;
    titleNorm: string;
    artistNorm: string;
  }> = [];

  const seenQueries = new Set<string>();
  const addAttempt = (q: string, t: string, a: string) => {
    const trimmed = q.trim();
    if (!trimmed || seenQueries.has(trimmed)) return;
    seenQueries.add(trimmed);
    queryAttempts.push({
      query: trimmed,
      titleNorm: normalizeForMatching(t),
      artistNorm: normalizeForMatching(a),
    });
  };

  if (parsed.artist) {
    addAttempt(
      `artist:"${escapeDeezerQuote(parsed.artist)}" track:"${escapeDeezerQuote(parsed.title)}"`,
      parsed.title,
      parsed.artist,
    );
  }
  addAttempt(`${parsed.title} ${parsed.artist}`, parsed.title, parsed.artist);

  if (parsed.altTitle && parsed.altArtist) {
    addAttempt(
      `artist:"${escapeDeezerQuote(parsed.altArtist)}" track:"${escapeDeezerQuote(parsed.altTitle)}"`,
      parsed.altTitle,
      parsed.altArtist,
    );
    addAttempt(
      `${parsed.altTitle} ${parsed.altArtist}`,
      parsed.altTitle,
      parsed.altArtist,
    );
  }

  const strippedTitle = stripAllParentheticals(parsed.title);
  if (strippedTitle && strippedTitle !== parsed.title) {
    addAttempt(
      `${strippedTitle} ${parsed.artist}`,
      strippedTitle,
      parsed.artist,
    );
  }

  let bestScore = -1;
  let bestIsrc: string | null = null;

  for (const attempt of queryAttempts) {
    if (input.signal?.aborted) return null;
    const tracks = await fetchDeezerTracks(attempt.query, input.signal);
    if (!tracks || tracks.length === 0) continue;

    for (const track of tracks) {
      const isrc = normalizeIsrc(track.isrc);
      if (!isrc) continue;

      const score = scoreIsrcCandidate({
        candidateTitle: track.title || track.title_short,
        candidateArtists: [track.artist?.name],
        candidateAlbum: track.album?.title,
        candidateDurationSec: track.duration,
        targetTitleNorm: attempt.titleNorm,
        targetArtistNorm: attempt.artistNorm,
        targetAlbumNorm,
        targetDurationSec: input.duration,
      });

      if (score > bestScore) {
        bestScore = score;
        bestIsrc = isrc;
      }
    }

    if (bestScore >= DEEZER_HIGH_CONFIDENCE_SCORE) {
      break;
    }
  }

  const threshold = parsed.artist ? 48 : 42;
  if (bestScore < threshold) return null;

  return bestIsrc;
}
