import { timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";

/**
 * Reserved API surface for the yeeahk online shop (www.yeeahk.com).
 *
 * Nothing here writes to the database yet. The routes exist so the shop team
 * can start integrating against stable paths and error shapes; each endpoint
 * documents the payload it will accept once implemented. Authentication is a
 * shared secret in the `X-Integration-Key` header, configured through the
 * `YEEAHK_INTEGRATION_KEY` environment variable.
 */
export const YEEAHK_BASE_PATH = "/api/integrations/yeeahk";
export const YEEAHK_KEY_HEADER = "x-integration-key";
export const YEEAHK_KEY_ENV = "YEEAHK_INTEGRATION_KEY";

type EndpointDoc = {
  method: "GET" | "POST";
  path: string;
  status: "available" | "planned";
  summary: string;
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
};

export const YEEAHK_ENDPOINTS: EndpointDoc[] = [
  {
    method: "GET",
    path: `${YEEAHK_BASE_PATH}/health`,
    status: "available",
    summary: "Confirms the integration key is accepted and lists endpoints.",
  },
  {
    method: "POST",
    path: `${YEEAHK_BASE_PATH}/members/sync`,
    status: "planned",
    summary:
      "Upsert shop members as event guests so their membership code can be scanned at the fair.",
    request: {
      eventId: "string (EventFlow event id)",
      members: [
        {
          memberCode: "string, 2-20 chars A-Z 0-9 '-'",
          name: "string",
          phone: "string (optional)",
          email: "string (optional)",
          externalId: "string (yeeahk customer id)",
        },
      ],
    },
    response: { created: "number", updated: "number", skipped: "number" },
  },
  {
    method: "POST",
    path: `${YEEAHK_BASE_PATH}/preorders/sync`,
    status: "planned",
    summary:
      "Push paid shop orders as pending pre-orders; merchants mark them collected after scanning the buyer's membership code.",
    request: {
      eventId: "string",
      preorders: [
        {
          externalId: "string (yeeahk order line id, idempotent)",
          memberCode: "string",
          merchantId: "string (EventFlow merchant id)",
          item: "string",
          quantity: "integer >= 1",
          amountCents: "integer >= 0",
          note: "string (optional)",
        },
      ],
    },
    response: { created: "number", unchanged: "number", rejected: "array" },
  },
  {
    method: "GET",
    path: `${YEEAHK_BASE_PATH}/preorders/status`,
    status: "planned",
    summary:
      "Read back collection status for pre-orders previously synced (query: eventId, externalId[]).",
  },
];

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function noStore(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

/** Returns true when the request may proceed; otherwise a response was sent. */
function authorize(req: Request, res: Response): boolean {
  noStore(res);
  const configured = process.env[YEEAHK_KEY_ENV]?.trim();
  if (!configured) {
    res.status(503).json({
      error: {
        code: "NOT_CONFIGURED",
        message: `yeeahk integration is reserved but not enabled; set ${YEEAHK_KEY_ENV} on the server to activate it.`,
      },
    });
    return false;
  }
  const presented = req.get(YEEAHK_KEY_HEADER)?.trim() ?? "";
  if (!presented || !constantTimeEquals(presented, configured)) {
    res.status(401).json({
      error: {
        code: "INVALID_INTEGRATION_KEY",
        message: `Provide the shared secret in the ${YEEAHK_KEY_HEADER} header.`,
      },
    });
    return false;
  }
  return true;
}

function notImplemented(endpoint: EndpointDoc) {
  return (req: Request, res: Response) => {
    if (!authorize(req, res)) return;
    res.status(501).json({
      error: {
        code: "NOT_IMPLEMENTED",
        message: `${endpoint.method} ${endpoint.path} is reserved for the yeeahk shop integration and is not implemented yet.`,
      },
      contract: endpoint,
    });
  };
}

export function registerIntegrationRoutes(app: Express): void {
  app.get(`${YEEAHK_BASE_PATH}/health`, (req, res) => {
    if (!authorize(req, res)) return;
    res.json({ ok: true, endpoints: YEEAHK_ENDPOINTS });
  });
  for (const endpoint of YEEAHK_ENDPOINTS) {
    if (endpoint.status !== "planned") continue;
    const handler = notImplemented(endpoint);
    if (endpoint.method === "POST") app.post(endpoint.path, handler);
    else app.get(endpoint.path, handler);
  }
}
