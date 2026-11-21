import { COOKIE_NAME } from "@shared/const";
import { TRPCError } from "@trpc/server";
import type { Request } from "express";
import { GOOGLE_SESSION_COOKIE } from "./_core/googleAuth";
import { getSessionCookieOptions } from "./_core/cookies";
import { clearGoogleTransactionCookie } from "./_core/googleTransactionCookie";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import {
  hasParticipantCookie,
  clearParticipantSession,
} from "./_core/participantAuth";
import { assertSameOriginJson } from "./eventflow/security";

function assertLogoutRequest(req: Request): void {
  const origin = req.get("origin");
  const fetchSite = req.get("sec-fetch-site");
  const contentType = req
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  try {
    // An actual Origin is required for this browser mutation. Fetch Metadata,
    // when supplied, must be same-origin even if Origin looks acceptable.
    if (!origin || (fetchSite !== undefined && fetchSite !== "same-origin"))
      throw new Error("Invalid origin or Fetch Metadata");
    const parsed = new URL(origin);
    if (
      origin !== parsed.origin ||
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      contentType !== "application/json"
    )
      throw new Error("Invalid origin or content type");
    // The shared check supports the Preview proxy's rewritten upstream Host
    // using browser-controlled same-origin Fetch Metadata.
    assertSameOriginJson(req);
  } catch {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "不接受跨站或非 JSON 登出請求",
    });
  }
}

export const appRouter = router({
  // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      assertLogoutRequest(ctx.req);
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      ctx.res.clearCookie(GOOGLE_SESSION_COOKIE, {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        path: "/",
      });
      clearGoogleTransactionCookie(ctx.res);
      if (hasParticipantCookie(ctx.req))
        clearParticipantSession(ctx.req, ctx.res);
      return {
        success: true,
      } as const;
    }),
  }),

  // TODO: add feature routers here, e.g.
  // todo: router({
  //   list: protectedProcedure.query(({ ctx }) =>
  //     db.getUserTodos(ctx.user.id)
  //   ),
  // }),
});

export type AppRouter = typeof appRouter;
