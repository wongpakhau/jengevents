import { describe, it, expect } from "vitest";
import type { Request } from "express";
import { sdk } from "./_core/sdk";
import { PARTICIPANT_COOKIE } from "../shared/participant";

describe("participant sessions cannot become staff", () => {
  it.each([
    `${PARTICIPANT_COOKIE}=opaque`,
    `${PARTICIPANT_COOKIE}=`,
    `${PARTICIPANT_COOKIE}=one; ${PARTICIPANT_COOKIE}=two`,
    `${PARTICIPANT_COOKIE}=bad; eventflow_google_session=stale`,
  ])("refuses staff identity even with a Preview header: %s", async cookie => {
    const req = {
      headers: { cookie, authorization: "Bearer stale-preview" },
      path: "/api/eventflow/session",
    } as Request;
    await expect(sdk.authenticateRequest(req)).rejects.toThrow(
      "Participant sessions cannot access staff workspace"
    );
  });
});
