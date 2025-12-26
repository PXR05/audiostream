export namespace AuthModel {
  export interface UserInfo {
    id: string;
    username: string;
    role: "admin" | "user";
    createdAt: Date;
    lastLoginAt?: Date;
  }

  export interface SessionInfo {
    id: string;
    userId: string;
    createdAt: Date;
    lastActivityAt: Date;
    expiresAt: Date;
    userAgent?: string;
  }

  export interface SessionAuthData {
    userId: string;
    username: string;
    role: "admin" | "user";
    sessionId: string;
  }

  export interface RegisterRequest {
    username: string;
    password: string;
  }

  export interface RegisterResponse {
    message: string;
    user: {
      id: string;
      username: string;
      role: string;
    };
    sessionId: string;
  }

  export interface LoginRequest {
    username: string;
    password: string;
  }

  export interface LoginResponse {
    message: string;
    user: {
      id: string;
      username: string;
      role: string;
    };
    sessionId: string;
  }

  export interface ChangePasswordRequest {
    currentPassword: string;
    newPassword: string;
  }

  export interface LogoutResponse {
    message: string;
  }
}
