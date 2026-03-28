const parseCorsOrigin = (
  origin: string | undefined,
): boolean | string | RegExp | string[] => {
  if (!origin || origin === "true" || origin === "*") return true;
  if (origin === "false") return false;

  if (origin.includes(",")) {
    return origin.split(",").map((o) => o.trim());
  }

  if (origin.startsWith("/") && origin.endsWith("/")) {
    return new RegExp(origin.slice(1, -1));
  }
  return origin;
};

export const corsConfig = {
  origin: parseCorsOrigin(process.env.CORS_ORIGIN),
  credentials: process.env.CORS_CREDENTIALS !== "false",
};