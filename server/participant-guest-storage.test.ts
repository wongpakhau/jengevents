import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import GuestPortal from "../client/src/pages/GuestPortal";
const token = "a".repeat(43);
afterEach(() => vi.unstubAllGlobals());
describe("temporary participant guest page with blocked browser storage", () => {
  it.each(["localStorage", "sessionStorage", "both"])(
    "a fragment invitation does not crash with %s getter blocked",
    kind => {
      const storage = { getItem: () => null };
      const windowMock = {
        location: { hash: `#invite=${token}`, pathname: "/guest", search: "" },
      };
      for (const name of ["localStorage", "sessionStorage"] as const)
        Object.defineProperty(windowMock, name, {
          get: () => {
            if (kind === name || kind === "both")
              throw new DOMException("storage blocked", "SecurityError");
            return storage;
          },
        });
      vi.stubGlobal("window", windowMock);
      vi.stubGlobal("React", React);
      expect(() =>
        renderToStaticMarkup(createElement(GuestPortal))
      ).not.toThrow();
    }
  );
});
