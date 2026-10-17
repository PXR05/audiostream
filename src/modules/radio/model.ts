import { t } from "elysia";
import { AudioModel } from "../audio/model";

export namespace RadioModel {
  export const radioQuery = t.Object({
    seed: t.String({ minLength: 1 }),
    limit: t.Optional(t.Number({ minimum: 1, maximum: 100, default: 25 })),
    lambda: t.Optional(t.Number({ minimum: 0, maximum: 1 })),
    temperature: t.Optional(t.Number({ minimum: 0, maximum: 1 })),
    seedNonce: t.Optional(t.String()),
    artistCooldown: t.Optional(t.Number({ minimum: 0, maximum: 20 })),
    albumCooldown: t.Optional(t.Number({ minimum: 0, maximum: 20 })),
  });
  export type radioQuery = typeof radioQuery.static;

  export const radioResponse = t.Object({
    files: t.Array(AudioModel.audioFile),
    seedId: t.String(),
    model: t.String(),
    dim: t.Number(),
    coverage: t.Number(),
    indexedCount: t.Number(),
    totalCount: t.Number(),
  });
  export type radioResponse = typeof radioResponse.static;

  export const radioStatusResponse = t.Object({
    model: t.String(),
    dim: t.Number(),
    sampleRate: t.Number(),
    indexedCount: t.Number(),
    totalCount: t.Number(),
    coverage: t.Number(),
  });
  export type radioStatusResponse = typeof radioStatusResponse.static;
}
