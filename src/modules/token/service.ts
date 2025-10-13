import { argon2id, argon2Verify } from "hash-wasm";
import { TokenRepository } from "../../db/repository";
import { logger } from "../../utils/logger";
import { checkIfAdmin } from "../../utils/auth";
import type { TokenModel } from "./model";

function generateSecureToken(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
}

export abstract class TokenService {
  static async createToken(
    name: string,
    userId?: string
  ): Promise<TokenModel.createTokenResponse> {
    const effectiveUserId = userId || "system";

    const existingTokens = await TokenRepository.findByUserId(effectiveUserId);
    const duplicateToken = existingTokens.find((t) => t.name === name);

    if (duplicateToken) {
      await TokenRepository.delete(duplicateToken.id);
      logger.info(
        `Deleted existing token: ${name} (user: ${effectiveUserId}, id: ${duplicateToken.id})`,
        { context: "TOKEN" }
      );
    }

    const id = crypto.randomUUID();
    const tokenId = crypto.randomUUID();
    const secretPart = generateSecureToken();
    const fullToken = `${tokenId}.${secretPart}`;
    const tokenHash = await argon2id({
      password: fullToken,
      salt: new Uint8Array(16),
      parallelism: 1,
      iterations: 2,
      memorySize: 19456,
      hashLength: 32,
      outputType: "encoded",
    });

    const token = await TokenRepository.create({
      id,
      name,
      userId: effectiveUserId,
      tokenId,
      hash: tokenHash,
      createdAt: new Date(),
      lastUsedAt: null,
    });

    logger.info(
      `Token created: ${name} (user: ${effectiveUserId}, id: ${id})`,
      {
        context: "TOKEN",
      }
    );

    return {
      id: token.id,
      name: token.name,
      userId: token.userId,
      token: fullToken,
      createdAt: token.createdAt,
    };
  }

  static async listTokens(userId?: string): Promise<TokenModel.tokenInfo[]> {
    const tokens = userId
      ? await TokenRepository.findByUserId(userId)
      : await TokenRepository.findAll();
    return tokens.map((token) => ({
      id: token.id,
      name: token.name,
      userId: token.userId,
      createdAt: token.createdAt,
      lastUsedAt: token.lastUsedAt ?? undefined,
    }));
  }

  static async deleteToken(id: string): Promise<boolean> {
    const deleted = await TokenRepository.delete(id);
    if (deleted) {
      logger.info(`Token deleted ${id}`, { context: "TOKEN" });
    }
    return deleted;
  }

  static async checkToken(
    token: string
  ): Promise<TokenModel.checkTokenResponse> {
    const isAdmin = await checkIfAdmin(token);

    if (isAdmin) {
      return { isAdmin: true };
    }

    const parts = token.split(".");
    if (parts.length !== 2) {
      throw new Error("Invalid token format");
    }

    const [tokenId] = parts;
    const dbToken = await TokenRepository.findByTokenId(tokenId);
    if (!dbToken) {
      throw new Error("Invalid token");
    }

    const isValid = await argon2Verify({
      password: token,
      hash: dbToken.hash,
    });

    if (!isValid) {
      throw new Error("Invalid token");
    }

    return {
      isAdmin: false,
      tokenInfo: {
        id: dbToken.id,
        name: dbToken.name,
        userId: dbToken.userId,
        createdAt: dbToken.createdAt,
        lastUsedAt: dbToken.lastUsedAt ?? undefined,
      },
    };
  }
}
