import { normalizeIsrc, cleanQueryTerm } from "./isrc";

const MUSICBRAINZ_API_URL = "https://musicbrainz.org/ws/2/recording";
const MUSICBRAINZ_TIMEOUT_MS = 15_000;

interface MusicBrainzRecording {
  title?: string;
  isrcs?: string[];
  "artist-credit"?: Array<{
    name?: string;
  }>;
}

interface MusicBrainzResponse {
  recordings?: MusicBrainzRecording[];
}

export async function getIsrcFromMusicBrainzSearch(input: {
  title?: string | null;
  artist?: string | null;
  signal?: AbortSignal;
}): Promise<string | null> {
  const title = cleanQueryTerm(input.title);
  if (!title) return null;

  const artist = cleanQueryTerm(input.artist);
  const query = `recording:"${title}"${artist ? ` AND artist:"${artist}"` : ""}`;
  const url = `${MUSICBRAINZ_API_URL}?query=${encodeURIComponent(query)}&limit=100&fmt=json`;

  try {
    const resp = await fetch(url, {
      signal: input.signal ?? AbortSignal.timeout(MUSICBRAINZ_TIMEOUT_MS),
      headers: {
        "User-Agent": "AudioStream/1.0.50 ( contact@example.com )",
        "Accept": "application/json",
      },
    });

    if (!resp.ok) {
      return null;
    }

    const body: MusicBrainzResponse = await resp.json();
    const recordings = body.recordings ?? [];

    for (const recording of recordings) {
      const isrcs = recording.isrcs ?? [];
      for (const rawIsrc of isrcs) {
        const normalized = normalizeIsrc(rawIsrc);
        if (normalized) {
          return normalized;
        }
      }
    }

    return null;
  } catch (error) {
    return null;
  }
}
