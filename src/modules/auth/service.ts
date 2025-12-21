import { argon2id, argon2Verify } from "hash-wasm";
import { UserRepository, SessionRepository } from "../../db/repositories";
import { logger } from "../../utils/logger";
import type { AuthModel } from "./model";
import { SignJWT, jwtVerify } from "jose";

const JWT_SECRET = process.env.JWT_SECRET || "default-secret";
const JWT_EXPIRATION = "15m";
const JWT_EXPIRATION_SECONDS = 15 * 60;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

async function hashPassword(password: string): Promise<string> {
  return await argon2id({
    password,
    salt: crypto.getRandomValues(new Uint8Array(16)),
    parallelism: 1,
    iterations: 3,
    memorySize: 65536,
    hashLength: 32,
    outputType: "encoded",
  });
}

async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  try {
    return await argon2Verify({ password, hash });
  } catch (error) {
    logger.error("Password verification failed", error, { context: "AUTH" });
    return false;
  }
}

async function generateJWT(
  userId: string,
  username: string,
  role: "admin" | "user",
  sessionId: string,
): Promise<string> {
  const secret = new TextEncoder().encode(JWT_SECRET);

  const token = await new SignJWT({
    userId,
    username,
    role,
    sessionId,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(JWT_EXPIRATION)
    .sign(secret);

  return token;
}

export async function verifyJWT(token: string): Promise<AuthModel.JWTPayload> {
  const secret = new TextEncoder().encode(JWT_SECRET);

  const { payload } = await jwtVerify(token, secret);

  return {
    userId: payload.userId as string,
    username: payload.username as string,
    role: payload.role as "admin" | "user",
    sessionId: payload.sessionId as string,
    iat: payload.iat as number,
    exp: payload.exp as number,
  };
}

export abstract class AuthService {
  static async register(
    username: string,
    password: string,
    role: "admin" | "user" = "user",
    userAgent?: string,
  ): Promise<AuthModel.RegisterResponse> {
    const existingUser = await UserRepository.findByUsername(username);
    if (existingUser) {
      throw new Error("Username already exists");
    }

    if (username.length < 3 || username.length > 50) {
      throw new Error("Username must be between 3 and 50 characters");
    }

    if (password.length < 6) {
      throw new Error("Password must be at least 6 characters");
    }

    const passwordHash = await hashPassword(password);

    const id = crypto.randomUUID();
    const user = await UserRepository.create({
      id,
      username,
      passwordHash,
      role,
      createdAt: new Date(),
      lastLoginAt: null,
    });

    const session = await SessionRepository.create(user.id, userAgent);

    logger.info(`User registered: ${username} (id: ${id}, role: ${role})`, {
      context: "AUTH",
    });

    const token = await generateJWT(user.id, user.username, role, session.id);

    return {
      message: "User registered successfully",
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
      },
      token,
      sessionId: session.id,
    };
  }

  static async login(
    username: string,
    password: string,
    userAgent?: string,
  ): Promise<AuthModel.LoginResponse> {
    const user = await UserRepository.findByUsername(username);
    if (!user) {
      throw new Error("Invalid username or password");
    }

    const isValid = await verifyPassword(password, user.passwordHash);
    if (!isValid) {
      throw new Error("Invalid username or password");
    }

    await UserRepository.updateLastLogin(user.id);

    const session = await SessionRepository.create(user.id, userAgent);

    logger.info(`User logged in: ${username} (id: ${user.id}, session: ${session.id})`, {
      context: "AUTH",
    });

    const token = await generateJWT(
      user.id,
      user.username,
      user.role as "admin" | "user",
      session.id,
    );

    return {
      message: "Login successful",
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
      },
      token,
      sessionId: session.id,
    };
  }

  static async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await UserRepository.findById(userId);
    if (!user) {
      throw new Error("User not found");
    }

    const isValid = await verifyPassword(currentPassword, user.passwordHash);
    if (!isValid) {
      throw new Error("Current password is incorrect");
    }

    if (newPassword.length < 6) {
      throw new Error("New password must be at least 6 characters");
    }

    const passwordHash = await hashPassword(newPassword);

    await UserRepository.update(userId, { passwordHash });

    logger.info(`Password changed for user: ${user.username} (id: ${userId})`, {
      context: "AUTH",
    });
  }

  static async getUserInfo(userId: string): Promise<AuthModel.UserInfo | null> {
    const user = await UserRepository.findById(userId);
    if (!user) {
      return null;
    }

    return {
      id: user.id,
      username: user.username,
      role: user.role as "admin" | "user",
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt ?? undefined,
    };
  }

  static async listUsers(): Promise<AuthModel.UserInfo[]> {
    const users = await UserRepository.findAll();
    return users.map((user) => ({
      id: user.id,
      username: user.username,
      role: user.role as "admin" | "user",
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt ?? undefined,
    }));
  }

  static async deleteUser(userId: string): Promise<boolean> {
    const deleted = await UserRepository.delete(userId);
    if (deleted) {
      logger.info(`User deleted: ${userId}`, { context: "AUTH" });
    }
    return deleted;
  }

  static async seedAdminUser(): Promise<void> {
    if (!ADMIN_PASSWORD) {
      logger.warn("ADMIN_PASSWORD not set. Skipping admin user creation.", {
        context: "AUTH",
      });
      return;
    }

    try {
      const existingAdmin = await UserRepository.findByUsername(ADMIN_USERNAME);

      if (existingAdmin) {
        logger.info(`Admin user '${ADMIN_USERNAME}' already exists`, {
          context: "AUTH",
        });
        return;
      }

      const result = await this.register(
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
        "admin",
      );

      logger.info(
        `Default admin user '${ADMIN_USERNAME}' created successfully`,
        { context: "AUTH" },
      );
      logger.info(`Admin user ID: ${result.user.id}`, { context: "AUTH" });
    } catch (error) {
      logger.error("Failed to seed admin user", error, { context: "AUTH" });
    }
  }

  static async refreshToken(
    sessionId: string,
  ): Promise<AuthModel.RefreshResponse> {
    const session = await SessionRepository.findValidById(sessionId);
    if (!session) {
      throw new Error("Invalid or expired session");
    }

    const user = await UserRepository.findById(session.userId);
    if (!user) {
      throw new Error("User not found");
    }

    await SessionRepository.updateActivity(sessionId);

    const token = await generateJWT(
      user.id,
      user.username,
      user.role as "admin" | "user",
      sessionId,
    );

    logger.info(`Token refreshed for user: ${user.username} (session: ${sessionId})`, {
      context: "AUTH",
    });

    return {
      token,
      expiresIn: JWT_EXPIRATION_SECONDS,
    };
  }

  static async logout(sessionId: string): Promise<AuthModel.LogoutResponse> {
    const revoked = await SessionRepository.revoke(sessionId);
    if (!revoked) {
      throw new Error("Session not found");
    }

    logger.info(`Session revoked: ${sessionId}`, { context: "AUTH" });

    return {
      message: "Logged out successfully",
    };
  }

  static async revokeAllSessions(userId: string): Promise<number> {
    const count = await SessionRepository.revokeAllForUser(userId);
    logger.info(`Revoked ${count} sessions for user: ${userId}`, {
      context: "AUTH",
    });
    return count;
  }

  static async getUserSessions(userId: string): Promise<AuthModel.SessionInfo[]> {
    const sessions = await SessionRepository.findByUserId(userId);
    return sessions
      .filter((s) => !s.isRevoked && s.expiresAt > new Date())
      .map((s) => ({
        id: s.id,
        userId: s.userId,
        createdAt: s.createdAt,
        lastActivityAt: s.lastActivityAt,
        expiresAt: s.expiresAt,
        userAgent: s.userAgent ?? undefined,
      }));
  }
}
