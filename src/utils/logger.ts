type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

interface LogOptions {
  timestamp?: boolean;
  context?: string;
}

const defaultOptions: LogOptions = {
  timestamp: true,
};

function formatMessage(
  level: LogLevel,
  message: string,
  options: LogOptions = {}
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

export const logger = {
  info: (message: string, options?: LogOptions) => {
    console.log(formatMessage("INFO", message, options));
  },

  warn: (message: string, options?: LogOptions) => {
    console.warn(formatMessage("WARN", message, options));
  },

  error: (message: string, error?: unknown, options?: LogOptions) => {
    const errorMessage = formatMessage("ERROR", message, options);
    console.error(errorMessage);

    if (error) {
      if (error instanceof Error) {
        console.error("  └─", error.message);
        if (error.stack) {
          console.error("  └─ Stack:", error.stack);
        }
      } else {
        console.error("  └─", error);
      }
    }
  },

  debug: (message: string, data?: unknown, options?: LogOptions) => {
    const debugMessage = formatMessage("DEBUG", message, options);
    console.log(debugMessage);

    if (data !== undefined) {
      console.log("  └─", data);
    }
  },
};
