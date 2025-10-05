import { verify } from "@node-rs/argon2";
import { env } from "bun";

const VALID_TOKEN = process.env.TOKEN;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

async function verifyToken(hash: string, plainToken: string): Promise<boolean> {
  try {
    return await verify(hash, plainToken);
  } catch (error) {
    console.error("Token verification error:", error);
    return false;
  }
}

export const authGuard =
  (requireAdmin: boolean = false) =>
  async ({ bearer, set }: { bearer?: string; set: any }) => {
    if (env.NODE_ENV !== "production") {
      return;
    }

    if (!bearer) {
      set.status = 401;
      set.headers["WWW-Authenticate"] =
        'Bearer realm="api", error="invalid_request"';
      return { error: "Authorization header required" };
    }

    if (ADMIN_TOKEN) {
      const isAdmin = await verifyToken(bearer, ADMIN_TOKEN);
      if (isAdmin) {
        return;
      }
    }

    if (requireAdmin) {
      if (!ADMIN_TOKEN) {
        set.status = 500;
        return { error: "Server admin authentication not configured" };
      }

      set.status = 403;
      set.headers["WWW-Authenticate"] =
        'Bearer realm="api", error="insufficient_scope"';
      return { error: "Admin token required for this operation" };
    }

    if (!VALID_TOKEN) {
      set.status = 500;
      return { error: "Server authentication not configured" };
    }

    const isValid = await verifyToken(bearer, VALID_TOKEN);

    if (!isValid) {
      set.status = 401;
      set.headers["WWW-Authenticate"] =
        'Bearer realm="api", error="invalid_token"';
      return { error: "Invalid token" };
    }
  };
