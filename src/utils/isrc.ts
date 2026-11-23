export const NO_ISRC_SENTINEL = "NO_ISRC";

const ISRC_PATTERN = /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/;

function normalizeCandidate(value: string): string | null {
  const cleaned = value.trim().toUpperCase().replace(/[\s-]/g, "");
  if (!cleaned) return null;

  if (cleaned === NO_ISRC_SENTINEL) {
    return NO_ISRC_SENTINEL;
  }

  if (!ISRC_PATTERN.test(cleaned)) {
    return null;
  }

  return cleaned;
}

export function normalizeIsrc(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== "string") continue;
      const normalized = normalizeCandidate(item);
      if (!normalized) continue;
      return normalized;
    }
    return null;
  }

  if (typeof value !== "string") {
    return null;
  }

  return normalizeCandidate(value);
}

export function toCheckedIsrc(value: unknown): string {
  return normalizeIsrc(value) ?? NO_ISRC_SENTINEL;
}

export function cleanQueryTerm(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .replace(
      /\s*[\(\[][^\)\]]*?(official|video|audio|music|lyrics?|hd|hq|4k|remaster(?:ed)?|edit|version|visualizer|mv|m\/v|pv|live|topic|explicit|clean|prod\.?[^)\]]*)[^\)\]]*?[\)\]]/gi,
      "",
    )
    .replace(/\s*(?:ft\.?|feat\.?|featuring|with)\s+.*/gi, "")
    .replace(/\s*-\s*Topic$/i, "")
    .replace(/\s*(?:VEVO|Official)$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function stripAllParentheticals(value: string): string {
  return value
    .replace(/\s*[\(\[][^\)\]]*[\)\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeForMatching(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function extractPrimaryArtist(
  artist?: string | null,
  artists?: string[] | null,
): string {
  const fromArray = artists?.find((a) => a && a.trim().length > 0)?.trim();
  const raw = fromArray || artist?.trim() || "";
  if (!raw) return "";
  const primary = raw
    .split(/\s*(?:;|,|&|\bx\b|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b)\s*/i)[0]
    ?.trim();
  return cleanQueryTerm(primary || raw);
}

export interface ParsedSearchTerms {
  title: string;
  artist: string;
  altTitle?: string;
  altArtist?: string;
}

export function parseTrackSearchTerms(input: {
  title?: string | null;
  artist?: string | null;
  artists?: string[] | null;
}): ParsedSearchTerms | null {
  const rawTitle = (input.title ?? "").trim();
  if (!rawTitle) return null;

  let title = cleanQueryTerm(rawTitle);
  let artist = extractPrimaryArtist(input.artist, input.artists);
  let altTitle: string | undefined;
  let altArtist: string | undefined;

  const dashMatch = rawTitle.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dashMatch) {
    const left = cleanQueryTerm(dashMatch[1]);
    const right = cleanQueryTerm(dashMatch[2]);
    if (left && right) {
      if (!artist) {
        artist = left;
        title = right;
      } else {
        const leftNorm = normalizeForMatching(left);
        const artistNorm = normalizeForMatching(artist);
        if (
          leftNorm &&
          artistNorm &&
          (leftNorm.includes(artistNorm) || artistNorm.includes(leftNorm))
        ) {
          title = right;
        } else {
          altArtist = left;
          altTitle = right;
        }
      }
    }
  }

  if (!title) title = rawTitle;
  return { title, artist, altTitle, altArtist };
}

export function tokenOverlapRatio(a: string, b: string): number {
  if (!a || !b) return 0;
  const aTokens = new Set(a.split(" ").filter(Boolean));
  const bTokens = new Set(b.split(" ").filter(Boolean));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap++;
  }
  return (2 * overlap) / (aTokens.size + bTokens.size);
}

export function scoreIsrcCandidate(input: {
  candidateTitle?: string | null;
  candidateArtists?: Array<string | null | undefined>;
  candidateAlbum?: string | null;
  candidateDurationSec?: number | null;
  targetTitleNorm: string;
  targetArtistNorm: string;
  targetAlbumNorm?: string;
  targetDurationSec?: number | null;
}): number {
  const candTitleNorm = normalizeForMatching(cleanQueryTerm(input.candidateTitle));
  if (!candTitleNorm || !input.targetTitleNorm) return -1;

  let score = 0;

  if (candTitleNorm === input.targetTitleNorm) {
    score += 60;
  } else if (
    candTitleNorm.includes(input.targetTitleNorm) ||
    input.targetTitleNorm.includes(candTitleNorm)
  ) {
    const ratio = tokenOverlapRatio(candTitleNorm, input.targetTitleNorm);
    score += 30 + Math.round(ratio * 20);
  } else {
    const ratio = tokenOverlapRatio(candTitleNorm, input.targetTitleNorm);
    if (ratio < 0.35) return 0;
    score += Math.round(ratio * 45);
  }

  if (input.targetArtistNorm) {
    let bestArtistScore = 0;
    for (const rawArtist of input.candidateArtists ?? []) {
      const candArtistNorm = normalizeForMatching(cleanQueryTerm(rawArtist));
      if (!candArtistNorm) continue;
      if (candArtistNorm === input.targetArtistNorm) {
        bestArtistScore = Math.max(bestArtistScore, 40);
      } else if (
        candArtistNorm.includes(input.targetArtistNorm) ||
        input.targetArtistNorm.includes(candArtistNorm)
      ) {
        bestArtistScore = Math.max(bestArtistScore, 28);
      } else {
        const ratio = tokenOverlapRatio(candArtistNorm, input.targetArtistNorm);
        bestArtistScore = Math.max(bestArtistScore, Math.round(ratio * 30));
      }
    }
    score += bestArtistScore;
    if (bestArtistScore === 0) {
      score -= 20;
    }
  }

  if (
    input.targetDurationSec &&
    input.targetDurationSec > 0 &&
    input.candidateDurationSec &&
    input.candidateDurationSec > 0
  ) {
    const diff = Math.abs(input.targetDurationSec - input.candidateDurationSec);
    if (diff <= 3) score += 20;
    else if (diff <= 8) score += 12;
    else if (diff <= 15) score += 4;
    else if (diff > 45) score -= 25;
    else if (diff > 25) score -= 12;
  }

  if (input.targetAlbumNorm && input.candidateAlbum) {
    const candAlbumNorm = normalizeForMatching(cleanQueryTerm(input.candidateAlbum));
    if (candAlbumNorm) {
      if (candAlbumNorm === input.targetAlbumNorm) score += 10;
      else if (tokenOverlapRatio(candAlbumNorm, input.targetAlbumNorm) >= 0.5) {
        score += 6;
      }
    }
  }

  return score;
}
