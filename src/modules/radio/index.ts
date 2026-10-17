import { Elysia } from "elysia";
import { RadioModel } from "./model";
import { RadioService } from "./service";
import { authPlugin } from "../../utils/auth";

export const radioController = new Elysia({ prefix: "/audio", tags: ["radio"] })
  .use(authPlugin)
  .model({
    "radio.query": RadioModel.radioQuery,
  })

  .get(
    "/radio",
    async ({ query, auth }) => {
      return await RadioService.getRadio(query.seed, auth.userId, {
        limit: query.limit,
        lambda: query.lambda,
        temperature: query.temperature,
        seed: query.seedNonce,
        artistCooldown: query.artistCooldown,
        albumCooldown: query.albumCooldown,
      });
    },
    {
      isAuth: true,
      query: "radio.query",
      response: {
        200: RadioModel.radioResponse,
      },
    },
  )

  .get(
    "/radio/status",
    async () => {
      return await RadioService.getStatus();
    },
    {
      isAuth: true,
      response: {
        200: RadioModel.radioStatusResponse,
      },
    },
  );
