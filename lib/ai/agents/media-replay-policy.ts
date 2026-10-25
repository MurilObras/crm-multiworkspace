import { z } from "zod";

export const mediaReplayPolicySchema = z.enum(["explicit_media_request", "explicit_repeat"]);
export type MediaReplayPolicy = z.infer<typeof mediaReplayPolicySchema>;
export function readMediaReplayPolicy(config: unknown): MediaReplayPolicy {
  const value =
    config && typeof config === "object"
      ? (config as Record<string, unknown>).media_replay_policy
      : undefined;
  return mediaReplayPolicySchema.catch("explicit_media_request").parse(value);
}
