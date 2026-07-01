import { hasRequiredPermission, parseSlashCommand } from "./commands";

describe("parseSlashCommand", () => {
  it("parses supported commands from the first non-empty line", () => {
    expect(parseSlashCommand("\n  /review please")).toBe("review");
    expect(parseSlashCommand("/robin")).toBe("review");
    expect(parseSlashCommand("/ROBIN please")).toBe("review");
    expect(parseSlashCommand("/summary")).toBe("summary");
    expect(parseSlashCommand("/help")).toBe("help");
  });

  it("does not parse inline mentions or command prefixes", () => {
    expect(parseSlashCommand("please /review this")).toBeUndefined();
    expect(parseSlashCommand("/reviewing this")).toBeUndefined();
    expect(parseSlashCommand("Looks good\n/review")).toBeUndefined();
  });
});

describe("hasRequiredPermission", () => {
  it("allows permissions at or above the configured minimum", () => {
    expect(hasRequiredPermission("admin", "write")).toBe(true);
    expect(hasRequiredPermission("maintain", "write")).toBe(true);
    expect(hasRequiredPermission("write", "write")).toBe(true);
  });

  it("rejects lower permissions", () => {
    expect(hasRequiredPermission("triage", "write")).toBe(false);
    expect(hasRequiredPermission("read", "triage")).toBe(false);
    expect(hasRequiredPermission("none", "read")).toBe(false);
  });
});
