import { mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

interface LogOptions {
  timestamp?: boolean;
  context?: string;
}

interface LoggerConfig {
  enableFileLogging?: boolean;
  logDirectory?: string;
  truncateAfterDays?: number;
  deleteAfterDays?: number;
  cleanupIntervalMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

const defaultOptions: LogOptions = {
  timestamp: true,
};

const defaultConfig: Required<LoggerConfig> = {
  enableFileLogging: true,
  logDirectory: "./logs",
  truncateAfterDays: 7,
  deleteAfterDays: 30,
  cleanupIntervalMs: 60 * 60 * 1000, // 1 hour
  maxRetries: 5,
  retryDelayMs: 100,
};

let currentConfig: Required<LoggerConfig> = { ...defaultConfig };
let lastCleanupTime: number = 0;

function formatMessage(
  level: LogLevel,
  message: string,
  options: LogOptions = {},
): string {
  const opts = { ...defaultOptions, ...options };
  const parts: string[] = [];

  if (opts.timestamp) {
    const now = new Date();
    const timestamp = now.toISOString();
    parts.push(`[${timestamp}]`);
  }

  parts.push(`[${level}]`);

  if (opts.context) {
    parts.push(`[${opts.context}]`);
  }

  parts.push(message);

  return parts.join(" ");
}

function getLogFileName(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}.log`;
}

function getLockFileName(logFileName: string): string {
  return `${logFileName}.lock`;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureLogDirectory(): Promise<void> {
  if (!existsSync(currentConfig.logDirectory)) {
    await mkdir(currentConfig.logDirectory, { recursive: true });
  }
}

async function acquireLock(lockFile: string): Promise<boolean> {
  try {
    const file = Bun.file(lockFile);
    const exists = await file.exists();

    if (exists) {
      const stats = await stat(lockFile);
      const lockAge = Date.now() - stats.mtime.getTime();
      if (lockAge > 30000) {
        await Bun.write(lockFile, Date.now().toString());
        return true;
      }
      return false;
    }

    await Bun.write(lockFile, Date.now().toString());
    return true;
  } catch (error) {
    return false;
  }
}

async function releaseLock(lockFile: string): Promise<void> {
  try {
    const file = Bun.file(lockFile);
    if (await file.exists()) {
      await Bun.write(lockFile, "");
    }
  } catch (error) {}
}

async function writeToLogFileWithRetry(
  logFile: string,
  content: string,
  retries: number = 0,
): Promise<void> {
  try {
    const file = Bun.file(logFile);
    const exists = await file.exists();

    if (exists) {
      const existingContent = await file.text();
      await Bun.write(logFile, existingContent + content);
    } else {
      await Bun.write(logFile, content);
    }
  } catch (error: any) {
    if (
      retries < currentConfig.maxRetries &&
      (error.code === "EBUSY" ||
        error.code === "EAGAIN" ||
        error.code === "EACCES")
    ) {
      const jitter = Math.random() * currentConfig.retryDelayMs;
      await sleep(currentConfig.retryDelayMs + jitter);
      return writeToLogFileWithRetry(logFile, content, retries + 1);
    }
    throw error;
  }
}

async function writeToLogFile(message: string): Promise<void> {
  if (!currentConfig.enableFileLogging) return;

  try {
    await ensureLogDirectory();
    const logFileName = getLogFileName();
    const logFile = join(currentConfig.logDirectory, logFileName);
    const lockFile = join(
      currentConfig.logDirectory,
      getLockFileName(logFileName),
    );
    const logEntry = `${message}\n`;

    let lockAcquired = false;
    for (let i = 0; i < currentConfig.maxRetries; i++) {
      lockAcquired = await acquireLock(lockFile);
      if (lockAcquired) break;
      await sleep(
        currentConfig.retryDelayMs + Math.random() * currentConfig.retryDelayMs,
      );
    }

    if (!lockAcquired) {
      await writeToLogFileWithRetry(logFile, logEntry);
      await checkAndRunCleanup();
      return;
    }

    try {
      await writeToLogFileWithRetry(logFile, logEntry);
      await checkAndRunCleanup();
    } finally {
      await releaseLock(lockFile);
    }
  } catch (error) {
    console.error("Failed to write to log file:", error);
  }
}

async function checkAndRunCleanup(): Promise<void> {
  const now = Date.now();
  const timeSinceLastCleanup = now - lastCleanupTime;

  if (timeSinceLastCleanup >= currentConfig.cleanupIntervalMs) {
    const cleanupLockFile = join(currentConfig.logDirectory, ".cleanup.lock");

    const lockAcquired = await acquireLock(cleanupLockFile);
    if (!lockAcquired) {
      return;
    }

    lastCleanupTime = now;

    cleanupOldLogs()
      .catch((error) => {
        console.error("Cleanup failed:", error);
      })
      .finally(() => {
        releaseLock(cleanupLockFile);
      });
  }
}

function extractTimestamp(line: string): Date | null {
  const timestampMatch = line.match(
    /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\]/,
  );
  if (timestampMatch) {
    return new Date(timestampMatch[1]);
  }
  return null;
}

function isDetailLine(line: string): boolean {
  return line.trim().startsWith("└─");
}

async function cleanupLogFile(filePath: string): Promise<void> {
  const lockFile = `${filePath}.cleanup.lock`;

  const lockAcquired = await acquireLock(lockFile);
  if (!lockAcquired) {
    return;
  }

  try {
    const file = Bun.file(filePath);
    const content = await file.text();
    const lines = content.split("\n");

    const now = Date.now();
    const truncateThresholdMs =
      currentConfig.truncateAfterDays * 24 * 60 * 60 * 1000;
    const deleteThresholdMs =
      currentConfig.deleteAfterDays * 24 * 60 * 60 * 1000;

    const processedLines: string[] = [];
    let currentEntryTimestamp: Date | null = null;
    let currentEntryAge: number = 0;

    for (const line of lines) {
      if (line.trim() === "") {
        processedLines.push(line);
        continue;
      }

      const timestamp = extractTimestamp(line);
      if (timestamp) {
        currentEntryTimestamp = timestamp;
        currentEntryAge = now - currentEntryTimestamp.getTime();

        if (currentEntryAge >= deleteThresholdMs) {
          continue;
        }

        processedLines.push(line);
      } else if (isDetailLine(line)) {
        if (currentEntryTimestamp && currentEntryAge < truncateThresholdMs) {
          processedLines.push(line);
        }
      } else {
        processedLines.push(line);
      }
    }

    const newContent = processedLines.join("\n");

    if (newContent !== content) {
      await Bun.write(filePath, newContent);
    }
  } catch (error) {
    console.error(`Failed to cleanup log file ${filePath}:`, error);
  } finally {
    await releaseLock(lockFile);
  }
}

async function cleanupOldLogs(): Promise<void> {
  if (!currentConfig.enableFileLogging) return;

  try {
    await ensureLogDirectory();
    const files = await readdir(currentConfig.logDirectory);
    let cleanedCount = 0;

    for (const file of files) {
      if (!file.endsWith(".log") || file.includes(".lock")) continue;

      const filePath = join(currentConfig.logDirectory, file);

      try {
        const statsBefore = await stat(filePath);
        const sizeBefore = statsBefore.size;

        await cleanupLogFile(filePath);

        const statsAfter = await stat(filePath);
        const sizeAfter = statsAfter.size;

        if (sizeAfter < sizeBefore) {
          cleanedCount++;
          const bytesRemoved = sizeBefore - sizeAfter;
          console.log(
            `Cleaned up log file: ${file} (removed ${bytesRemoved} bytes)`,
          );
        }
      } catch (error) {
        console.error(`Failed to process ${file}:`, error);
      }
    }

    if (cleanedCount > 0) {
      console.log(`Cleanup complete: processed ${cleanedCount} log file(s)`);
    }
  } catch (error) {
    console.error("Failed to cleanup old logs:", error);
  }
}

export const logger = {
  configure: (config: LoggerConfig) => {
    currentConfig = { ...currentConfig, ...config };
  },

  info: async (message: string, options?: LogOptions) => {
    const formattedMessage = formatMessage("INFO", message, options);
    console.log(formattedMessage);
    await writeToLogFile(formattedMessage);
  },

  warn: async (message: string, options?: LogOptions) => {
    const formattedMessage = formatMessage("WARN", message, options);
    console.warn(formattedMessage);
    await writeToLogFile(formattedMessage);
  },

  error: async (message: string, error?: unknown, options?: LogOptions) => {
    const errorMessage = formatMessage("ERROR", message, options);
    console.error(errorMessage);
    await writeToLogFile(errorMessage);

    if (error) {
      if (error instanceof Error) {
        const errorDetails = `  └─ ${error.message}`;
        console.error(errorDetails);
        await writeToLogFile(errorDetails);

        if (error.stack) {
          const stackTrace = `  └─ Stack: ${error.stack}`;
          console.error(stackTrace);
          await writeToLogFile(stackTrace);
        }
      } else {
        const errorDetails = `  └─ ${JSON.stringify(error)}`;
        console.error(errorDetails);
        await writeToLogFile(errorDetails);
      }
    }
  },

  debug: async (message: string, data?: unknown, options?: LogOptions) => {
    const debugMessage = formatMessage("DEBUG", message, options);
    console.log(debugMessage);
    await writeToLogFile(debugMessage);

    if (data !== undefined) {
      const dataString =
        typeof data === "object"
          ? `  └─ ${JSON.stringify(data, null, 2)}`
          : `  └─ ${data}`;
      console.log(dataString);
      await writeToLogFile(dataString);
    }
  },

  manualCleanup: async () => {
    const cleanupLockFile = join(currentConfig.logDirectory, ".cleanup.lock");
    const lockAcquired = await acquireLock(cleanupLockFile);

    if (!lockAcquired) {
      throw new Error("Cleanup is already running in another worker");
    }

    try {
      lastCleanupTime = Date.now();
      await cleanupOldLogs();
    } finally {
      await releaseLock(cleanupLockFile);
    }
  },

  getConfig: () => ({ ...currentConfig }),
};
