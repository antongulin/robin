import { getHelpMessage } from "./review-prompts";

describe("getHelpMessage", () => {
  it("keeps command and permission guidance readable beside one decorative mark", () => {
    const body = getHelpMessage();
    expect(body.match(/<img\b/g)).toHaveLength(1);
    expect(body).toMatch(/^<img [^>]*width="24" height="24" alt=""[^>]*> Available commands for \*\*Robin\*\*:/);
    expect(body).toContain("| /review or /robin | Full code review");
    expect(body).toContain("| /summary | Concise PR overview");
    expect(body).toContain("| /help | Show this message |");
    expect(body).toContain("pushes to an existing PR are skipped");
    expect(body).toContain("permission-checked before the LLM is called");
    expect(body).toContain("uses your own LLM endpoint");
  });
});
