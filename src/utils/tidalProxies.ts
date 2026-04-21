const TIDAL_PROXY_LIST_URL =
  process.env.TIDAL_PROXY_LIST_URL ||
  "https://gist.githubusercontent.com/afkarxyz/2ce772b943321b9448b454f39403ce25/raw";
const TIDAL_PROXY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const TIDAL_PROXY_LIST_TIMEOUT_MS = 10_000;

const TIDAL_FALLBACK_PROXY_APIS = [
  "https://tidal-api.binimum.org",
  "https://maus.qqdl.site",
  "https://hund.qqdl.site",
  "https://katze.qqdl.site",
  "https://wolf.qqdl.site",
  "https://hifi-two.spotisaver.net",
  "https://eu-central.monochrome.tf",
  "https://hifi.geeked.wtf",
  "https://monochrome-api.samidy.com",
  "https://us-west.monochrome.tf",
  "https://api.monochrome.tf",
];

export const TIDAL_PROXY_APIS = TIDAL_FALLBACK_PROXY_APIS;

let tidalProxyApiCache: string[] | null = null;
let tidalProxyApiCacheExpiresAt = 0;
let tidalProxyApiFetchPromise: Promise<string[]> | null = null;

function parseTidalProxyList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const unique = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;

    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        unique.add(trimmed.replace(/\/+$/, ""));
      }
    } catch {
      continue;
    }
  }

  return Array.from(unique);
}

async function fetchTidalProxyApis(signal?: AbortSignal): Promise<string[]> {
  const resp = await fetch(TIDAL_PROXY_LIST_URL, {
    signal: signal ?? AbortSignal.timeout(TIDAL_PROXY_LIST_TIMEOUT_MS),
  });

  if (!resp.ok) {
    throw new Error(`Failed to fetch Tidal proxy list: HTTP ${resp.status}`);
  }

  const body: unknown = await resp.json();
  const parsed = parseTidalProxyList(body);
  if (parsed.length === 0) {
    throw new Error("Fetched Tidal proxy list is empty");
  }

  return parsed;
}

export async function getTidalProxyApis(
  signal?: AbortSignal,
): Promise<string[]> {
  const now = Date.now();
  if (tidalProxyApiCache && now < tidalProxyApiCacheExpiresAt) {
    return tidalProxyApiCache;
  }

  if (tidalProxyApiFetchPromise) {
    return tidalProxyApiFetchPromise;
  }

  tidalProxyApiFetchPromise = (async () => {
    try {
      const proxies = await fetchTidalProxyApis(signal);
      tidalProxyApiCache = proxies;
      tidalProxyApiCacheExpiresAt = Date.now() + TIDAL_PROXY_CACHE_TTL_MS;
      return proxies;
    } catch {
      return TIDAL_FALLBACK_PROXY_APIS;
    } finally {
      tidalProxyApiFetchPromise = null;
    }
  })();

  return tidalProxyApiFetchPromise;
}
