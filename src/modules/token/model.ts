export namespace TokenModel {
  export interface tokenInfo {
    id: string;
    name: string;
    userId: string;
    createdAt: Date;
    lastUsedAt?: Date;
  }

  export interface createTokenRequest {
    name: string;
    userId?: string;
  }

  export interface createTokenResponse {
    id: string;
    name: string;
    userId: string;
    token: string;
    createdAt: Date;
  }

  export interface checkTokenResponse {
    isAdmin: boolean;
    tokenInfo?: {
      id: string;
      name: string;
      userId: string;
      createdAt: Date;
      lastUsedAt?: Date;
    };
  }
}
