import { verify } from "@node-rs/argon2";
import { logger } from "./logger";
import { TokenRepository } from "../db/repository";

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

async function verifyHash(hash: string, plainToken: string): Promise<boolean> {
  try {
    return await verify(hash, plainToken);
  } catch (error) {
    logger.error("Token verification failed", error, { context: "AUTH" });
    return false;
  }
}

export async function checkIfAdmin(token: string): Promise<boolean> {
  if (!ADMIN_TOKEN) return false;
  return await verifyHash(ADMIN_TOKEN, token);
}

async function verifyTokenAgainstDb(token: string): Promise<{
  valid: boolean;
  tokenData?: {
    id: string;
    name: string;
    userId: string;
  };
}> {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) {
      return { valid: false };
    }

    const [tokenId] = parts;
    const dbToken = await TokenRepository.findByTokenId(tokenId);

    if (!dbToken) {
      return { valid: false };
    }

    const isValid = await verifyHash(dbToken.hash, token);

    if (!isValid) {
      return { valid: false };
    }

    return {
      valid: true,
      tokenData: {
        id: dbToken.id,
        name: dbToken.name,
        userId: dbToken.userId,
      },
    };
  } catch (error) {
    logger.error("Token verification failed", error, { context: "AUTH" });
    return { valid: false };
  }
}

export const authGuard =
  (requireAdmin: boolean = false) =>
  async (context: { bearer?: string; set: any; store?: any }) => {
    const { bearer, set } = context;

    if (!bearer) {
      set.status = 401;
      set.headers["WWW-Authenticate"] =
        'Bearer realm="api", error="invalid_request"';
      return { error: "Authorization header required" };
    }

    if (requireAdmin) {
      if (!ADMIN_TOKEN) {
        set.status = 500;
        return { error: "Server admin authentication not configured" };
      }

      const isAdmin = await verifyHash(ADMIN_TOKEN, bearer);
      if (!isAdmin) {
        set.status = 403;
        set.headers["WWW-Authenticate"] =
          'Bearer realm="api", error="insufficient_scope"';
        return { error: "Admin token required for this operation" };
      }

      if (context.store) {
        context.store.auth = { isAdmin: true };
      }
      return;
    }

    if (ADMIN_TOKEN) {
      const isAdmin = await verifyHash(ADMIN_TOKEN, bearer);
      if (isAdmin) {
        if (context.store) {
          context.store.auth = { isAdmin: true };
        }
        return;
      }
    }

    const result = await verifyTokenAgainstDb(bearer);
    if (result.valid && result.tokenData) {
      await TokenRepository.updateLastUsed(result.tokenData.id);

      if (context.store) {
        context.store.auth = {
          isAdmin: false,
          userId: result.tokenData.userId,
          tokenId: result.tokenData.id,
          tokenName: result.tokenData.name,
        };
      }
      return;
    }

    set.status = 401;
    set.headers["WWW-Authenticate"] =
      'Bearer realm="api", error="invalid_token"';
    return { error: "Invalid token" };
  };
