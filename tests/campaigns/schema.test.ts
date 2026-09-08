import { expect, it } from "vitest";
import { campaignCreateSchema, campaignFiltersSchema } from "@/lib/campaigns/schema";

it("audience accepts only tag and optional source", () => {
  expect(campaignFiltersSchema.parse({ tag: " vip ", source: "manual" })).toEqual({ tag: "vip", source: "manual" });
  expect(campaignFiltersSchema.safeParse({ tag: "vip", pipeline_id: "x" }).success).toBe(false);
  expect(campaignFiltersSchema.safeParse({ source: "manual" }).success).toBe(false);
});
it("steps keep literal text, cap delay and reject future scheduling", () => {
  const input = {
    id: "a0000000-0000-4000-8000-000000000001", name: "Campaign",
    channel_session_id: "a0000000-0000-4000-8000-000000000002",
    steps: [{ message: " Hi {{name}} \n", delay_minutes: 0 }, { message: "Follow", delay_minutes: 60 }],
    hourly_limit: 1, filters: { tag: "vip" },
  };
  const parsed = campaignCreateSchema.parse(input);
  expect(parsed.steps).toHaveLength(2);
  expect(parsed.steps[0]!.message).toBe(input.steps[0]!.message);
  expect(campaignCreateSchema.safeParse({ ...input, steps: [] }).success).toBe(false);
  expect(campaignCreateSchema.safeParse({ ...input, steps: [{ message: "x", delay_minutes: -1 }] }).success).toBe(false);
  expect(campaignCreateSchema.safeParse({ ...input, steps: [{ message: "   ", delay_minutes: 0 }] }).success).toBe(false);
  expect(campaignCreateSchema.safeParse({ ...input, scheduled_at: "2027-01-01" }).success).toBe(false);
  expect(campaignCreateSchema.safeParse({ ...input, hourly_limit: 0 }).success).toBe(false);
});
