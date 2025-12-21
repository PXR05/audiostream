import { query, command, getRequestEvent } from "$app/server";
import * as v from "valibot";
import { error } from "@sveltejs/kit";
import {
  GetCurrentUserResponseSchema,
  ListUsersResponseSchema,
  CreateUserResponseSchema,
  ResetPasswordResponseSchema,
  DeleteUserResponseSchema,
} from "$lib/schemas/auth";
import { API_URL as BACKEND_URL } from "$env/static/private";

const ListUsersOptionsSchema = v.object({
  page: v.optional(v.number()),
  limit: v.optional(v.number()),
});

const CreateUserSchema = v.object({
  username: v.string(),
  password: v.string(),
});

const ResetPasswordSchema = v.object({
  userId: v.string(),
  newPassword: v.string(),
});

function getAuthToken(): string | undefined {
  const { cookies } = getRequestEvent();
  return cookies.get("cadence.token");
}

export const getCurrentUser = query(async () => {
  const authHash = getAuthToken();

  if (!authHash) {
    throw error(401, "Unauthorized: No authentication provided");
  }

  const response = await fetch(`${BACKEND_URL}/auth/me`, {
    headers: {
      Authorization: `Bearer ${authHash}`,
    },
  });

  if (!response.ok) {
    throw error(response.status, `Backend error: ${response.statusText}`);
  }

  const data = await response.json();
  return v.parse(GetCurrentUserResponseSchema, data);
});

export const listUsers = query(ListUsersOptionsSchema, async (options) => {
  const authHash = getAuthToken();

  if (!authHash) {
    throw error(401, "Unauthorized: No authentication provided");
  }

  const { page = 1, limit = 10 } = options;
  const params = new URLSearchParams({
    page: page.toString(),
    limit: limit.toString(),
  });

  const response = await fetch(`${BACKEND_URL}/auth/users?${params}`, {
    headers: {
      Authorization: `Bearer ${authHash}`,
    },
  });

  if (!response.ok) {
    throw error(response.status, `Backend error: ${response.statusText}`);
  }

  const data = await response.json();
  return v.parse(ListUsersResponseSchema, data);
});

export const createUser = command(CreateUserSchema, async (input) => {
  const authHash = getAuthToken();

  const response = await fetch(`${BACKEND_URL}/auth/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authHash && { Authorization: `Bearer ${authHash}` }),
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw error(response.status, errorData.error || "Failed to create user");
  }

  const data = await response.json();
  return v.parse(CreateUserResponseSchema, data);
});

export const resetUserPassword = command(ResetPasswordSchema, async (input) => {
  const authHash = getAuthToken();

  if (!authHash) {
    throw error(401, "Unauthorized: No authentication provided");
  }

  const response = await fetch(
    `${BACKEND_URL}/auth/users/${input.userId}/password`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authHash}`,
      },
      body: JSON.stringify({ newPassword: input.newPassword }),
    }
  );

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw error(response.status, errorData.error || "Failed to reset password");
  }

  const data = await response.json();
  return v.parse(ResetPasswordResponseSchema, data);
});

export const deleteUser = command(v.string(), async (id) => {
  const authHash = getAuthToken();

  if (!authHash) {
    throw error(401, "Unauthorized: No authentication provided");
  }

  const response = await fetch(`${BACKEND_URL}/auth/users/${id}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${authHash}`,
    },
  });

  if (!response.ok) {
    throw error(response.status, `Backend error: ${response.statusText}`);
  }

  const data = await response.json();
  return v.parse(DeleteUserResponseSchema, data);
});
