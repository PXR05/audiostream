import * as v from "valibot";

export const UserSchema = v.object({
  id: v.string(),
  username: v.string(),
  role: v.picklist(["admin", "user"]),
  createdAt: v.optional(v.string()),
  lastLoginAt: v.optional(v.string()),
});

export const GetCurrentUserResponseSchema = v.object({
  data: UserSchema,
});

export const ListUsersResponseSchema = v.object({
  data: v.array(UserSchema),
  hasMore: v.optional(v.boolean()),
  currentPage: v.optional(v.number()),
  totalPages: v.optional(v.number()),
});

export const CreateUserResponseSchema = v.object({
  message: v.string(),
  user: UserSchema,
});

export const ResetPasswordResponseSchema = v.object({
  message: v.string(),
});

export const DeleteUserResponseSchema = v.object({
  message: v.string(),
});

export const ListUsersOptionsSchema = v.object({
  page: v.optional(v.number()),
  limit: v.optional(v.number()),
});

export const CreateUserSchema = v.object({
  username: v.string(),
  password: v.string(),
});

export const ResetPasswordSchema = v.object({
  userId: v.string(),
  newPassword: v.string(),
});

export type User = v.InferOutput<typeof UserSchema>;
export type GetCurrentUserResponse = v.InferOutput<
  typeof GetCurrentUserResponseSchema
>;
export type ListUsersResponse = v.InferOutput<typeof ListUsersResponseSchema>;
export type CreateUserResponse = v.InferOutput<typeof CreateUserResponseSchema>;
export type ResetPasswordResponse = v.InferOutput<
  typeof ResetPasswordResponseSchema
>;
export type DeleteUserResponse = v.InferOutput<typeof DeleteUserResponseSchema>;
export type ListUsersOptions = v.InferOutput<typeof ListUsersOptionsSchema>;
export type CreateUserInput = v.InferOutput<typeof CreateUserSchema>;
export type ResetPasswordInput = v.InferOutput<typeof ResetPasswordSchema>;
