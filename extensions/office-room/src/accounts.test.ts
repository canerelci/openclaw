// Office Room tests cover account resolution and the optional-token contract.
import { describe, expect, it } from "vitest";
import { listOfficeRoomAccountIds, resolveOfficeRoomAccount } from "./accounts.js";
import type { CoreConfig } from "./types.js";

function cfg(officeRoom: Record<string, unknown>): CoreConfig {
  return { channels: { "office-room": officeRoom } } as unknown as CoreConfig;
}

const baseAccount = {
  baseUrl: "http://127.0.0.1:4319/",
  projectId: "organ-bank",
  participantName: "Pryva",
};

describe("resolveOfficeRoomAccount", () => {
  it("is configured without a token because the engine ships without auth", () => {
    const account = resolveOfficeRoomAccount({ cfg: cfg(baseAccount) });
    expect(account.configured).toBe(true);
    expect(account.token).toBe("");
    expect(account.baseUrl).toBe("http://127.0.0.1:4319");
  });

  it("is unconfigured until baseUrl, projectId, and participantName are all set", () => {
    expect(resolveOfficeRoomAccount({ cfg: cfg({ baseUrl: "http://x" }) }).configured).toBe(false);
    expect(
      resolveOfficeRoomAccount({ cfg: cfg({ ...baseAccount, participantName: "" }) }).configured,
    ).toBe(false);
  });

  it("defaults the Product Owner contract: role and reply target follow the lead", () => {
    const account = resolveOfficeRoomAccount({ cfg: cfg({ ...baseAccount, leadName: "Mira" }) });
    expect(account.role).toBe("product-owner");
    expect(account.participantKind).toBe("openclaw");
    expect(account.defaultTo).toBe("dm:Mira");
  });

  it("broadcasts by default when no lead is configured", () => {
    expect(resolveOfficeRoomAccount({ cfg: cfg(baseAccount) }).defaultTo).toBe("room");
  });

  it("honours an explicit defaultTo over the lead fallback", () => {
    const account = resolveOfficeRoomAccount({
      cfg: cfg({ ...baseAccount, leadName: "Mira", defaultTo: "room" }),
    });
    expect(account.defaultTo).toBe("room");
  });

  it("reads a bearer token from an env secret ref", () => {
    const account = resolveOfficeRoomAccount({
      cfg: cfg({
        ...baseAccount,
        token: { source: "env", provider: "default", id: "OFFICE_ROOM_TOKEN" },
      }),
      env: { OFFICE_ROOM_TOKEN: "secret-value" },
    });
    expect(account.token).toBe("secret-value");
  });

  it("accepts a literal bearer token", () => {
    expect(resolveOfficeRoomAccount({ cfg: cfg({ ...baseAccount, token: "t0k" }) }).token).toBe(
      "t0k",
    );
  });

  it("disables the channel when enabled is false", () => {
    expect(resolveOfficeRoomAccount({ cfg: cfg({ ...baseAccount, enabled: false }) }).enabled).toBe(
      false,
    );
  });

  it("lists the implicit default account once top-level config is present", () => {
    expect(listOfficeRoomAccountIds(cfg(baseAccount))).toContain("default");
    // An empty channel block still lists the default id, but it resolves to an
    // unconfigured account, which is what keeps the gateway from starting.
    expect(resolveOfficeRoomAccount({ cfg: cfg({}) }).configured).toBe(false);
  });
});
