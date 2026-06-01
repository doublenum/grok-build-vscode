import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../webview/src/markdown";

describe("renderMarkdown emphasis", () => {
  it("does not let an asterisk inside inline code trigger runaway italics", () => {
    // `research/*.cjs` and `plan-*` each carry a stray "*". Before the fix these
    // paired up across the prose between them and wrapped it all in <em>.
    const html = renderMarkdown(
      "Probes in `research/*.cjs` are excluded; see `plan-*` and `design-*` too.",
    );
    expect(html).not.toContain("<em>");
    // the prose between the code spans stays plain
    expect(html).toContain("are excluded; see");
  });

  it("still renders real single-asterisk italics", () => {
    expect(renderMarkdown("this is *important* text")).toContain("<em>important</em>");
  });

  it("still renders bold", () => {
    expect(renderMarkdown("this is **strong** text")).toContain("<strong>strong</strong>");
  });

  it("keeps the asterisk literally inside the rendered code span", () => {
    const html = renderMarkdown("path is `research/*.cjs` here");
    expect(html).toContain("<code>research/*.cjs</code>");
  });

  it("does not emphasize across an asterisk in code even with a later real italic", () => {
    const html = renderMarkdown("`a*b` then plain then *realitalic*");
    expect(html).toContain("<code>a*b</code>");
    expect(html).toContain("<em>realitalic</em>");
  });
});
