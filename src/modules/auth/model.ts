import { t } from "elysia";

export namespace AuthModel {
  export const registerBody = t.Object({
    username: t.String({ minLength: 3, maxLength: 50 }),
    password: t.String({ minLength: 6 }),
  });

  export const loginBody = t.Object({
    username: t.String(),
    password: t.String(),
  });

  export const changePasswordBody = t.Object({
    currentPassword: t.String(),
    newPassword: t.String({ minLength: 6 }),
  });

  export const userParams = t.Object({ id: t.String() });

  export const userObject = t.Object({
    id: t.String(),
    username: t.String(),
    role: t.String(),
  });

  export const userInfo = t.Object({
    id: t.String(),
    username: t.String(),
    role: t.Union([t.Literal("admin"), t.Literal("user")]),
    createdAt: t.Date(),
    lastLoginAt: t.Optional(t.Date()),
  });

  export const sessionInfo = t.Object({
    id: t.String(),
    userId: t.String(),
    createdAt: t.Date(),
    lastActivityAt: t.Date(),
    expiresAt: t.Date(),
    userAgent: t.Optional(t.String()),
  });

  export const messageResponse = t.Object({ message: t.String() });
  export const errorResponse = t.Object({ error: t.String() });

  export const authResponse = t.Object({
    message: t.String(),
    user: userObject,
  });
  export const meResponse = t.Object({ data: userInfo });
  export const usersListResponse = t.Object({ data: t.Array(userInfo) });
  export const sessionsListResponse = t.Object({ data: t.Array(sessionInfo) });

  export type UserInfo = typeof userInfo.static;
  export type SessionInfo = typeof sessionInfo.static;

  export interface SessionAuthData {
    userId: string;
    username: string;
    role: "admin" | "user";
    sessionId: string;
  }

  export interface RegisterResponse {
    message: string;
    user: { id: string; username: string; role: string };
    sessionId: string;
  }

  export interface LoginResponse {
    message: string;
    user: { id: string; username: string; role: string };
    sessionId: string;
  }

  export interface LogoutResponse {
    message: string;
  }
}
