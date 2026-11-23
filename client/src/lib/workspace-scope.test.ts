import { describe, expect, it } from "vitest";
import {
  settlementErrorAction,
  stateScopeKey,
  workspaceScopeKey,
} from "./workspace-scope";

describe("workspace scoped snapshots", () => {
  it("changes for event, role, and authorized merchant assignment", () => {
    const base = workspaceScopeKey("event-a", "admin", [{ id: "m-1" }]);
    expect(workspaceScopeKey("event-b", "admin", [{ id: "m-1" }])).not.toBe(base);
    expect(workspaceScopeKey("event-a", "merchant", [{ id: "m-1" }])).not.toBe(base);
    expect(workspaceScopeKey("event-a", "admin", [{ id: "m-2" }])).not.toBe(base);
    expect(workspaceScopeKey("event-a", "admin", [{ id: "m-1" }, { id: "m-2" }])).not.toBe(base);
  });

  it("is order independent and includes the server returned merchant scope", () => {
    expect(workspaceScopeKey("event-a", "merchant", [{ id: "m-2" }, { id: "m-1" }])).toBe(
      workspaceScopeKey("event-a", "merchant", [{ id: "m-1" }, { id: "m-2" }])
    );
    expect(stateScopeKey("event-a", null)).toBe("event-a|none|");
  });

  it("drops stale responses from another scope", () => {
    expect(settlementErrorAction(undefined, "event-a|admin|m-1", "event-a|merchant|m-1")).toBe("clear");
    expect(settlementErrorAction(500, "event-a|admin|m-1", "event-a|merchant|m-1")).toBe("clear");
  });

  it("clears unauthorized errors and retains only same-scope transient failures", () => {
    const scope = "event-a|merchant|m-1";
    expect(settlementErrorAction(401, scope, scope)).toBe("clear");
    expect(settlementErrorAction(403, scope, scope)).toBe("clear");
    expect(settlementErrorAction(404, scope, scope)).toBe("clear");
    expect(settlementErrorAction(503, scope, scope)).toBe("retain");
    expect(settlementErrorAction(503, null, scope)).toBe("clear");
  });
});
