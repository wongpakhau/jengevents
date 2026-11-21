import { describe, expect, it } from "vitest";
import { SESSION_EVENTS_SQL } from "./eventflow/session-query";

describe("session events SQL", () => {
  it("includes updated_at in DISTINCT projection to avoid MySQL 3065", () => {
    const projection = SESSION_EVENTS_SQL.split(" FROM ")[0];
    expect(projection).toContain("e.updated_at");
    expect(SESSION_EVENTS_SQL).toContain("ORDER BY e.updated_at DESC");
  });
  it("retains active membership and owner scope with all three bound identity parameters", () => {
    expect(SESSION_EVENTS_SQL).toContain("m.user_id = ? AND m.active = 1");
    expect(SESSION_EVENTS_SQL).toContain(
      "WHERE (e.owner_user_id = ? OR m.user_id = ?) AND e.owner_user_id IS NOT NULL"
    );
    expect(SESSION_EVENTS_SQL).toContain("o.owner_user_id IS NOT NULL");
    expect(SESSION_EVENTS_SQL.match(/\?/g)).toHaveLength(3);
  });
});
