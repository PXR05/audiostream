import { createLocalStorageState } from "./localStorage.svelte";

const AUTH_URL = "/api/auth";

interface User {
  id: string;
  username: string;
  role: "admin" | "user";
  createdAt?: string;
  lastLoginAt?: string;
}

interface JWTPayload {
  userId: string;
  username: string;
  role: "admin" | "user";
  iat?: number;
  exp?: number;
}

function decodeJWT(token: string): JWTPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return null;
    }

    const payload = parts[1];
    const decoded = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(decoded) as JWTPayload;
  } catch (error) {
    console.error("Failed to decode JWT:", error);
    return null;
  }
}

function isTokenExpired(token: string): boolean {
  const payload = decodeJWT(token);
  if (!payload || !payload.exp) {
    return true;
  }

  return payload.exp * 1000 < Date.now();
}

interface LoginResponse {
  message: string;
  user: User;
  token: string;
}

interface RegisterResponse {
  message: string;
  user: User;
  token: string;
}

interface GetCurrentUserResponse {
  data: User;
}

class AuthStore {
  private tokenStore = createLocalStorageState<string | null>(
    "cadence.token",
    null,
  );

  user = $state<User | null>(null);

  constructor() {
    this.restoreUserFromToken();
  }

  get token(): string | null {
    return this.tokenStore.value;
  }

  get isAuthenticated(): boolean {
    return this.tokenStore.value !== null && this.user !== null;
  }

  get isAdmin(): boolean {
    return this.user?.role === "admin";
  }

  async login(username: string, password: string): Promise<void> {
    try {
      const response = await fetch(`${AUTH_URL}/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ username, password }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || "Login failed");
      }

      const data: LoginResponse = await response.json();
      await this.setToken(data.token);
      this.user = data.user;
    } catch (error) {
      console.error("Login failed:", error);
      throw error;
    }
  }

  async register(username: string, password: string): Promise<void> {
    try {
      const response = await fetch(`${AUTH_URL}/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ username, password }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || "Registration failed");
      }

      const data: RegisterResponse = await response.json();
      await this.setToken(data.token);
      this.user = data.user;
    } catch (error) {
      console.error("Registration failed:", error);
      throw error;
    }
  }

  async getCurrentUser(): Promise<User | null> {
    if (!this.token) {
      return null;
    }

    if ("onLine" in navigator && !navigator.onLine) {
      this.restoreUserFromToken();
      return this.user;
    }

    try {
      const response = await fetch(`${AUTH_URL}/me`);

      if (!response.ok) {
        if (response.status === 401) {
          this.logout();
          return null;
        }
        throw new Error("Failed to get current user");
      }

      const data: GetCurrentUserResponse = await response.json();
      this.user = data.data;
      return data.data;
    } catch (error) {
      console.error("Failed to get current user:", error);

      this.restoreUserFromToken();
      return this.user;
    }
  }

  private restoreUserFromToken(): void {
    const token = this.token;
    if (!token) {
      this.user = null;
      return;
    }

    if (isTokenExpired(token) && "onLine" in navigator && navigator.onLine) {
      console.warn("Token is expired, clearing auth state");
      this.logout();
      return;
    }

    const payload = decodeJWT(token);
    if (!payload) {
      console.error("Failed to decode token");
      this.logout();
      return;
    }

    this.user = {
      id: payload.userId,
      username: payload.username,
      role: payload.role,
    };
  }

  async changePassword(
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    try {
      const response = await fetch(`${AUTH_URL}/change-password`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ currentPassword, newPassword }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to change password");
      }
    } catch (error) {
      console.error("Failed to change password:", error);
      throw error;
    }
  }

  async setToken(token: string): Promise<void> {
    try {
      this.tokenStore.value = token;

      if (typeof document !== "undefined") {
        document.cookie = `cadence.token=${token}; path=/; max-age=604800; SameSite=Strict`;
      }
    } catch (error) {
      console.error("Failed to set token:", error);
      throw new Error("Failed to set token");
    }
  }

  logout(): void {
    this.tokenStore.clear();
    this.user = null;

    if (typeof document !== "undefined") {
      document.cookie = "cadence.token=; path=/; max-age=0";
    }
  }

  clearToken(): void {
    this.logout();
  }
}

export const authStore = new AuthStore();
