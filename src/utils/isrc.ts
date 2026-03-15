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
