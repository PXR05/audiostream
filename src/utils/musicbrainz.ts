import {
  cleanQueryTerm,
  normalizeForMatching,
  normalizeIsrc,
  parseTrackSearchTerms,
  scoreIsrcCandidate,
  stripAllParentheticals,
} from "./isrc";

const MUSICBRAINZ_API_URL = "https://musicbrainz.org/ws/2/recording";
const MUSICBRAINZ_TIMEOUT_MS = 15_000;
const MUSICBRAINZ_MIN_INTERVAL_MS = 1_100;
const MUSICBRAINZ_USER_AGENT =
  "AudioStream/1.0 ( https://github.com/PXR05/audiostream )";
const MUSICBRAINZ_HIGH_CONFIDENCE_SCORE = 85;

interface MusicBrainzRecording {
  score?: number;
  title?: string;
  length?: number;
  isrcs?: string[];
  "artist-credit"?: Array<{
    name?: string;
    artist?: { name?: string };
  }>;
  releases?: Array<{
    title?: string;
  }>;
}

interface MusicBrainzResponse {
  recordings?: MusicBrainzRecording[];
}

let nextAllowedAt = 0;
let rateLimitChain: Promise<void> = Promise.resolve();

function waitForMusicBrainzSlot(signal?: AbortSignal): Promise<void> {
  const job = rateLimitChain.then(async () => {
    if (signal?.aborted) return;
    const waitMs = Math.max(0, nextAllowedAt - Date.now());
    if (waitMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitMs);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
    nextAllowedAt = Date.now() + MUSICBRAINZ_MIN_INTERVAL_MS;
  });
  rateLimitChain = job.catch(() => {});
  return job;
}

function escapeLucenePhrase(value: string): string {
  return value.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
}

function escapeLuceneTokens(value: string): string {
  return value
    .replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchMusicBrainzRecordings(
  query: string,
  signal?: AbortSignal,
): Promise<MusicBrainzRecording[] | null> {
  const url = `${MUSICBRAINZ_API_URL}?query=${encodeURIComponent(query)}&limit=25&fmt=json`;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) return null;
    await waitForMusicBrainzSlot(signal);
    if (signal?.aborted) return null;

    try {
      const fetchSignal = signal
        ? AbortSignal.any([
            signal,
            AbortSignal.timeout(MUSICBRAINZ_TIMEOUT_MS),
          ])
        : AbortSignal.timeout(MUSICBRAINZ_TIMEOUT_MS);

      const resp = await fetch(url, {
        signal: fetchSignal,
        headers: {
          "User-Agent": MUSICBRAINZ_USER_AGENT,
          Accept: "application/json",
        },
      });

      if ((resp.status === 503 || resp.status === 429) && attempt === 0) {
        nextAllowedAt = Date.now() + 2_500;
        continue;
      }
      if (!resp.ok) return null;

      const body = (await resp.json()) as MusicBrainzResponse;
      return body.recordings ?? [];
    } catch {
      return null;
    }
  }
  return null;
}

export async function getIsrcFromMusicBrainzSearch(input: {
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

  const titlePhrase = escapeLucenePhrase(parsed.title);
  const artistPhrase = escapeLucenePhrase(parsed.artist);
  if (titlePhrase) {
    addAttempt(
      artistPhrase
        ? `recording:"${titlePhrase}" AND artist:"${artistPhrase}"`
        : `recording:"${titlePhrase}"`,
      parsed.title,
      parsed.artist,
    );
  }

  const titleTokens = escapeLuceneTokens(stripAllParentheticals(parsed.title));
  const artistTokens = escapeLuceneTokens(parsed.artist);
  if (titleTokens) {
    addAttempt(
      artistTokens
        ? `recording:(${titleTokens}) AND artist:(${artistTokens})`
        : `recording:(${titleTokens})`,
      stripAllParentheticals(parsed.title),
      parsed.artist,
    );
  }

  if (parsed.altTitle && parsed.altArtist) {
    const altTitlePhrase = escapeLucenePhrase(parsed.altTitle);
    const altArtistPhrase = escapeLucenePhrase(parsed.altArtist);
    if (altTitlePhrase && altArtistPhrase) {
      addAttempt(
        `recording:"${altTitlePhrase}" AND artist:"${altArtistPhrase}"`,
        parsed.altTitle,
        parsed.altArtist,
      );
    }
  }

  let bestScore = -1;
  let bestIsrc: string | null = null;

  for (const attempt of queryAttempts) {
    if (input.signal?.aborted) return null;
    const recordings = await fetchMusicBrainzRecordings(
      attempt.query,
      input.signal,
    );
    if (!recordings || recordings.length === 0) continue;

    for (const recording of recordings) {
      const validIsrc = (recording.isrcs ?? [])
        .map((raw) => normalizeIsrc(raw))
        .find((isrc): isrc is string => Boolean(isrc));
      if (!validIsrc) continue;

      const candidateArtists = (recording["artist-credit"] ?? []).flatMap(
        (credit) => [credit.name, credit.artist?.name],
      );
      const candidateDurationSec =
        typeof recording.length === "number" && recording.length > 0
          ? recording.length / 1000
          : undefined;
      const candidateAlbum = recording.releases?.[0]?.title;

      let score = scoreIsrcCandidate({
        candidateTitle: recording.title,
        candidateArtists,
        candidateAlbum,
        candidateDurationSec,
        targetTitleNorm: attempt.titleNorm,
        targetArtistNorm: attempt.artistNorm,
        targetAlbumNorm,
        targetDurationSec: input.duration,
      });

      if (typeof recording.score === "number" && recording.score > 0) {
        score += Math.round(recording.score / 20);
      }

      if (score > bestScore) {
        bestScore = score;
        bestIsrc = validIsrc;
      }
    }

    if (bestScore >= MUSICBRAINZ_HIGH_CONFIDENCE_SCORE) {
      break;
    }
  }

  const threshold = parsed.artist ? 50 : 45;
  if (bestScore < threshold) return null;

  return bestIsrc;
}
