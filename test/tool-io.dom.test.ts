// DOM-level tests for the sidebar port of the editor-tab IN/OUT tool card.
// A tool call's one-line label stays the summary; clicking it reveals the raw
// input and output in bordered boxes with "in"/"out" gutter labels (mirroring
// webview/src/App.tsx). Drives the REAL media/chat.js inside happy-dom.
import { describe, it, expect } from "vitest";
import { bootWebview, dispatch, click } from "./webview-harness";

// A lone tool call sheds its group chrome on the next agent message, becoming a
// standalone .tool-item.tool-flat card. messageChunk -> appendAgent ->
// closeToolGroup is the path that performs that conversion.
function runOneToolThenSettle(window: any, doc: any, call: Record<string, unknown>): HTMLElement {
  dispatch(window, { type: "toolCall", call });
  dispatch(window, { type: "messageChunk", text: "done" });
  return doc.querySelector(".tool-item.tool-flat") as HTMLElement;
}

describe("tool IN/OUT card (sidebar port of the editor-tab style)", () => {
  it("collapses a single call to an expandable card whose head toggles IN/OUT boxes", () => {
    const { window, doc } = bootWebview();

    dispatch(window, {
      type: "toolCall",
      call: { toolCallId: "t1", tool: "bash", rawInput: { command: "npm test" } },
    });
    dispatch(window, {
      type: "toolCallUpdate",
      call: { toolCallId: "t1", content: [{ type: "content", content: { type: "text", text: "223 passed" } }] },
    });
    dispatch(window, { type: "messageChunk", text: "done" });

    const item = doc.querySelector(".tool-item.tool-flat") as HTMLElement;
    expect(item).toBeTruthy();
    // collapsed: no IN/OUT boxes rendered yet
    expect(item.querySelector(".tool-io")).toBeNull();

    click(window, item.querySelector(".tool-item-head")!);

    const labels = item.querySelectorAll(".io-label");
    const boxes = item.querySelectorAll(".tool-io");
    expect(boxes).toHaveLength(2);
    expect(labels[0].textContent).toBe("in");
    expect(boxes[0].textContent).toBe("npm test");
    expect(labels[1].textContent).toBe("out");
    expect(boxes[1].textContent).toBe("223 passed");

    // toggling closed hides the body
    click(window, item.querySelector(".tool-item-head")!);
    expect((item.querySelector(".tool-item-body") as HTMLElement).hidden).toBe(true);
  });

  it("re-renders the open body when output arrives after the card is expanded", () => {
    const { window, doc } = bootWebview();
    const item = runOneToolThenSettle(window, doc, {
      toolCallId: "t2",
      tool: "bash",
      rawInput: { command: "ls" },
    });

    click(window, item.querySelector(".tool-item-head")!); // expand with only IN present
    expect(item.querySelectorAll(".tool-io")).toHaveLength(1);
    expect(item.querySelector(".tool-io")!.textContent).toBe("ls");

    // late output update re-renders the already-open body
    dispatch(window, { type: "toolCallUpdate", call: { toolCallId: "t2", content: [{ text: "file.txt" }] } });
    const boxes = item.querySelectorAll(".tool-io");
    expect(boxes).toHaveLength(2);
    expect(boxes[1].textContent).toBe("file.txt");
  });

  it("keeps grouping multiple calls; each item expands independently to its own IN", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "toolCall", call: { toolCallId: "a", tool: "read_file", rawInput: { path: "src/a.ts" } } });
    dispatch(window, { type: "toolCall", call: { toolCallId: "b", tool: "bash", rawInput: { command: "ls -la" } } });
    dispatch(window, { type: "messageChunk", text: "done" });

    // two calls stay a group (no flat conversion)
    expect(doc.querySelector(".tool-item.tool-flat")).toBeNull();
    const items = doc.querySelectorAll(".tool-group-body .tool-item");
    expect(items).toHaveLength(2);

    click(window, items[1].querySelector(".tool-item-head")!);
    const box = items[1].querySelector(".tool-io");
    expect(box!.textContent).toBe("ls -la");
    // the sibling stayed collapsed
    expect(items[0].querySelector(".tool-io")).toBeNull();
  });
});
