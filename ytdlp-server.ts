const PORT = Number(Deno.env.get("PORT") || "8080");
const TEMP_DIR = Deno.env.get("TEMP_DIR") || "/tmp/ytdlp";
const COOKIES_PATH = Deno.env.get("COOKIES_PATH") || "/app/cookies.txt";
const FILE_TTL_MS = Number(Deno.env.get("FILE_TTL_SECONDS") || "600") * 1000;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/140.0.0.0 Safari/537.36";

const PROGRESS_FULL_RE =
  /\[download\]\s+(\d+\.?\d*)%\s+of\s+~?(\S+)\s+at\s+(\S+)\s+ETA\s+(\S+)/;
const PROGRESS_SIMPLE_RE = /\[download\]\s+(\d+\.?\d*)%/;
const FILE_ID_RE = /^[a-f0-9-]{32,36}$/;

let cachedVersion: string | null = null;
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

function hasCookies(): boolean {
  try {
    const info = Deno.statSync(COOKIES_PATH);
    return info.isFile && info.size > 0;
  } catch {
    return false;
  }
}

function buildBaseArgs(): string[] {
  const client = (Deno.env.get("YOUTUBE_CLIENT") || "").trim();
  const args: string[] = ["--no-cache-dir"];

  if (hasCookies()) {
    args.push("--cookies", COOKIES_PATH);
  }
  if (
    client &&
    client.toLowerCase() !== "none" &&
    client.toLowerCase() !== "false"
  ) {
    args.push("--extractor-args", `youtube:player_client=${client}`);
  }

  args.push(
    "-f",
    "bestaudio",
    "-x",
    "--audio-format",
    "opus",
    "--embed-metadata",
    "--embed-thumbnail",
    "--parse-metadata",
    "%(artist,uploader,channel,creator)s:%(meta_artist)s",
    "--replace-in-metadata",
    "meta_artist",
    ",\\s*",
    "; ",
    "--parse-metadata",
    "%(meta_artist)s:%(album_artist)s",
    "--parse-metadata",
    "%(meta_artist)s:%(artist)s",
  );
  return args;
}

function parseProgress(line: string): Record<string, unknown> | null {
  const full = line.match(PROGRESS_FULL_RE);
  if (full) {
    return {
      percent: parseFloat(full[1]),
      totalSize: full[2],
      speed: full[3],
      eta: full[4],
    };
  }
  const simple = line.match(PROGRESS_SIMPLE_RE);
  return simple ? { percent: parseFloat(simple[1]) } : null;
}

function cleanupJobDir(fileId: string): void {
  const timer = cleanupTimers.get(fileId);
  if (timer !== undefined) {
    clearTimeout(timer);
    cleanupTimers.delete(fileId);
  }
  try {
    Deno.removeSync(`${TEMP_DIR}/${fileId}`, { recursive: true });
  } catch {
    // ignore
  }
}

function scheduleCleanup(fileId: string): void {
  const timer = setTimeout(() => {
    cleanupTimers.delete(fileId);
    try {
      Deno.removeSync(`${TEMP_DIR}/${fileId}`, { recursive: true });
    } catch {
      // ignore
    }
  }, FILE_TTL_MS);
  cleanupTimers.set(fileId, timer);
}

async function getYtDlpVersion(): Promise<string> {
  if (cachedVersion) return cachedVersion;
  const out = await new Deno.Command("yt-dlp", {
    args: ["--version"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(
      new TextDecoder().decode(out.stderr).trim() || "yt-dlp --version failed",
    );
  }
  cachedVersion = new TextDecoder().decode(out.stdout).trim();
  return cachedVersion;
}

async function handlePlaylistInfo(req: Request): Promise<Response> {
  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const url = (body.url || "").trim();
  if (!url) {
    return Response.json({ error: "Missing url" }, { status: 400 });
  }

  const args = [
    "--no-cache-dir",
    ...(hasCookies() ? ["--cookies", COOKIES_PATH] : []),
    "--user-agent",
    USER_AGENT,
    "--ignore-errors",
    "--dump-json",
    "--flat-playlist",
    url,
  ];

  const child = new Deno.Command("yt-dlp", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  const onAbort = () => {
    try {
      child.kill("SIGTERM");
    } catch { }
  };
  req.signal.addEventListener("abort", onAbort, { once: true });

  try {
    const out = await child.output();
    const stdout = new TextDecoder().decode(out.stdout);
    const stderr = new TextDecoder().decode(out.stderr);
    const entries: unknown[] = [];

    for (const rawLine of stdout.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        entries.push(JSON.parse(line));
      } catch { }
    }

    return Response.json({ entries, stderr, exitCode: out.code });
  } finally {
    req.signal.removeEventListener("abort", onAbort);
  }
}

async function handleDownload(req: Request): Promise<Response> {
  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const url = (body.url || "").trim();
  if (!url) {
    return Response.json({ error: "Missing url" }, { status: 400 });
  }

  const fileId = crypto.randomUUID().replaceAll("-", "");
  const jobDir = `${TEMP_DIR}/${fileId}`;
  const outputPath = `${jobDir}/${fileId}.opus`;
  await Deno.mkdir(jobDir, { recursive: true });

  const args = [
    ...buildBaseArgs(),
    "--newline",
    "--no-playlist",
    "-o",
    outputPath,
    url,
  ];
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: Record<string, unknown>) =>
        controller.enqueue(encoder.encode(JSON.stringify(payload) + "\n"));

      const child = new Deno.Command("yt-dlp", {
        args,
        stdout: "piped",
        stderr: "piped",
      }).spawn();

      const killChild = () => {
        try {
          child.kill("SIGTERM");
        } catch { }
      };
      req.signal.addEventListener("abort", killChild, { once: true });

      const stderrPromise = new Response(child.stderr).text();
      let succeeded = false;

      try {
        const reader = child.stdout.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          if (req.signal.aborted) {
            await reader.cancel().catch(() => { });
            break;
          }
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.includes("[download]")) {
              const data = parseProgress(line);
              if (data) send({ type: "progress", data });
            } else if (line.includes("[ExtractAudio]")) {
              send({
                type: "stage",
                stage: "extract_audio",
                message: "Converting audio...",
              });
            } else if (line.includes("[EmbedThumbnail]")) {
              send({
                type: "stage",
                stage: "embed_thumbnail",
                message: "Embedding thumbnail...",
              });
            }
          }
        }

        const status = await child.status;
        const stderrText = (await stderrPromise).trim();

        if (req.signal.aborted) return;

        if (!status.success) {
          send({
            type: "error",
            message:
              stderrText.slice(0, 500) ||
              `yt-dlp exited with code ${status.code}`,
          });
          return;
        }

        const stat = await Deno.stat(outputPath);
        succeeded = true;
        scheduleCleanup(fileId);
        send({ type: "done", fileId, size: stat.size });
      } catch (err) {
        if (!req.signal.aborted) {
          send({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        req.signal.removeEventListener("abort", killChild);
        if (!succeeded) {
          killChild();
          cleanupJobDir(fileId);
        }
        try {
          controller.close();
        } catch { }
      }
    },
    cancel() {
      cleanupJobDir(fileId);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
    },
  });
}

await Deno.mkdir(TEMP_DIR, { recursive: true });
const startupVersion = await getYtDlpVersion().catch(() => "unknown");
console.log(
  `[ytdlp-bridge] listening on :${PORT} (yt-dlp ${startupVersion}, cookies=${hasCookies()})`,
);

Deno.serve({ hostname: "0.0.0.0", port: PORT }, async (req) => {
  const { pathname } = new URL(req.url);

  if (req.method === "GET" && pathname === "/health") {
    try {
      return Response.json({
        ok: true,
        version: await getYtDlpVersion(),
        hasCookies: hasCookies(),
      });
    } catch (err) {
      return Response.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        { status: 503 },
      );
    }
  }
  if (req.method === "POST" && pathname === "/playlist-info") {
    return await handlePlaylistInfo(req);
  }
  if (req.method === "POST" && pathname === "/download") {
    return await handleDownload(req);
  }
  if (pathname.startsWith("/files/")) {
    const fileId = pathname.slice("/files/".length);
    if (!FILE_ID_RE.test(fileId)) {
      return Response.json({ error: "Invalid file id" }, { status: 400 });
    }
    if (req.method === "GET") {
      try {
        const file = await Deno.open(`${TEMP_DIR}/${fileId}/${fileId}.opus`, {
          read: true,
        });
        return new Response(file.readable, {
          status: 200,
          headers: { "Content-Type": "audio/ogg" },
        });
      } catch {
        return Response.json({ error: "File not found" }, { status: 404 });
      }
    }
    if (req.method === "DELETE") {
      cleanupJobDir(fileId);
      return Response.json({ ok: true });
    }
  }

  return Response.json({ error: "Not found" }, { status: 404 });
});
