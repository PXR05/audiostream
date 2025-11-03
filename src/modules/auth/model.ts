export namespace AuthModel {
  export interface UserInfo {
    id: string;
    username: string;
    role: "admin" | "user";
    createdAt: Date;
    lastLoginAt?: Date;
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
    token: string;
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
    token: string;
  }

  export interface ChangePasswordRequest {
    currentPassword: string;
    newPassword: string;
  }

  export interface JWTPayload {
    userId: string;
    username: string;
    role: "admin" | "user";
    iat: number;
    exp: number;
  }
}
