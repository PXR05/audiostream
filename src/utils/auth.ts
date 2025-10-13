import { argon2Verify } from "hash-wasm";
import { Elysia } from "elysia";
import { bearer } from "@elysiajs/bearer";
import { logger } from "./logger";
import { TokenRepository } from "../db/repository";

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

export type AuthData =
  | {
      isAdmin: true;
    }
  | {
      isAdmin: false;
      userId: string;
      tokenId: string;
      tokenName: string;
    };

async function verifyHash(hash: string, plainToken: string): Promise<boolean> {
  try {
    return await argon2Verify({ password: plainToken, hash });
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

export const authPlugin = new Elysia({ name: "auth" }).use(bearer()).macro({
  isAuth(enabled: boolean) {
    if (!enabled) return;

    return {
      resolve: async ({ bearer, set, store }) => {
        const storeWithAuth = store as typeof store & { auth?: AuthData };

        if (!bearer) {
          set.status = 401;
          set.headers["WWW-Authenticate"] =
            'Bearer realm="api", error="invalid_request"';
          throw new Error("Authorization header required");
        }

        if (ADMIN_TOKEN) {
          const isAdmin = await verifyHash(ADMIN_TOKEN, bearer);
          if (isAdmin) {
            const authData: AuthData = { isAdmin: true };
            storeWithAuth.auth = authData;
            return { auth: authData };
          }
        }

        const result = await verifyTokenAgainstDb(bearer);
        if (result.valid && result.tokenData) {
          await TokenRepository.updateLastUsed(result.tokenData.id);

          const authData: AuthData = {
            isAdmin: false,
            userId: result.tokenData.userId,
            tokenId: result.tokenData.id,
            tokenName: result.tokenData.name,
          };
          storeWithAuth.auth = authData;
          return { auth: authData };
        }

        set.status = 401;
        set.headers["WWW-Authenticate"] =
          'Bearer realm="api", error="invalid_token"';
        throw new Error("Invalid token");
      },
    };
  },
  isAdmin(enabled: boolean) {
    if (!enabled) return;

    return {
      resolve: async ({ bearer, set, store }) => {
        const storeWithAuth = store as typeof store & { auth?: AuthData };

        if (!bearer) {
          set.status = 401;
          set.headers["WWW-Authenticate"] =
            'Bearer realm="api", error="invalid_request"';
          throw new Error("Authorization header required");
        }

        if (!ADMIN_TOKEN) {
          set.status = 500;
          throw new Error("Server admin authentication not configured");
        }

        const isAdmin = await verifyHash(ADMIN_TOKEN, bearer);
        if (!isAdmin) {
          set.status = 403;
          set.headers["WWW-Authenticate"] =
            'Bearer realm="api", error="insufficient_scope"';
          throw new Error("Admin token required for this operation");
        }

        const authData: AuthData = { isAdmin: true };
        storeWithAuth.auth = authData;
        return { auth: authData };
      },
    };
  },
});
