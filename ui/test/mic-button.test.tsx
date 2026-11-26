// @vitest-environment jsdom
// Voice typing: the mic button on board text fields. Hidden without the Web Speech API; with it, a click starts a
// continuous en-US recognition (red, pulsing), heard text lands at the cursor, a second click stops, nothing is sent.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { insertAt, MicButton, type Recognition } from "../src/MicButton";

class FakeRecognition implements Recognition {
  static last: FakeRecognition | null = null;
  continuous = false;
  interimResults = false;
  lang = "";
  onresult: Recognition["onresult"] = null;
  onend: Recognition["onend"] = null;
  onerror: Recognition["onerror"] = null;
  start = vi.fn();
  stop = vi.fn(() => this.onend?.());
  abort = vi.fn();
  constructor() {
    FakeRecognition.last = this;
  }
  hear(transcript: string, isFinal = true) {
    const result = Object.assign([{ transcript }], { isFinal });
    this.onresult?.({ resultIndex: 0, results: [result] as never });
  }
}

function Field({ initial = "", onSubmit = () => {} }: { initial?: string; onSubmit?: () => void }) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <form onSubmit={onSubmit}>
      <textarea ref={ref} aria-label="Reply" value={text} onChange={(e) => setText(e.target.value)} />
      <MicButton field={ref} value={text} onChange={setText} />
    </form>
  );
}

const w = window as unknown as { webkitSpeechRecognition?: unknown; SpeechRecognition?: unknown };

describe("MicButton", () => {
  afterEach(() => {
    cleanup();
    delete w.webkitSpeechRecognition;
    delete w.SpeechRecognition;
    FakeRecognition.last = null;
    vi.unstubAllGlobals();
  });

  it("shows a hint instead of a button when the browser has no speech recognition", () => {
    render(<Field />);
    expect(screen.queryByRole("button", { name: /voice typing/i })).toBeNull();
    expect(screen.getByRole("img", { name: /Voice typing isn't supported/ })).toBeTruthy();
  });

  it("starts continuous en-US recognition, inserts heard text at the cursor, and stops on a second click", () => {
    w.webkitSpeechRecognition = FakeRecognition;
    const onSubmit = vi.fn();
    render(<Field initial="Hello world" onSubmit={onSubmit} />);
    const box = screen.getByLabelText("Reply") as HTMLTextAreaElement;
    box.focus();
    box.setSelectionRange(5, 5);

    const mic = screen.getByRole("button", { name: "Voice typing" });
    fireEvent.click(mic);
    const rec = FakeRecognition.last!;
    expect(rec.start).toHaveBeenCalledOnce();
    expect([rec.continuous, rec.interimResults, rec.lang]).toEqual([true, true, "en-US"]);
    expect(mic.className).toContain("listening");
    expect(mic.getAttribute("aria-pressed")).toBe("true");

    act(() => rec.hear("the", false)); // interim words show live, then get replaced as they firm up
    expect(box.value).toBe("Hello the world");
    act(() => rec.hear("there"));
    expect(box.value).toBe("Hello there world");
    expect(box.selectionStart).toBe("Hello there".length);
    act(() => rec.hear("big", false));
    expect(box.value).toBe("Hello there big world");
    act(() => rec.hear("big"));
    expect(box.value).toBe("Hello there big world");

    fireEvent.click(screen.getByRole("button", { name: "Stop voice typing" }));
    expect(rec.stop).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Voice typing" }).className).not.toContain("listening");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("uses the standard SpeechRecognition when present", () => {
    w.SpeechRecognition = FakeRecognition;
    render(<Field />);
    fireEvent.click(screen.getByRole("button", { name: "Voice typing" }));
    expect(FakeRecognition.last).not.toBeNull();
  });

  it("spaces inserted text from its neighbours", () => {
    expect(insertAt("", " hi ", 0, 0)).toEqual({ value: "hi", caret: 2 });
    expect(insertAt("ab", "x", 1, 1)).toEqual({ value: "a x b", caret: 3 });
    expect(insertAt("a ", "x", 2, 2)).toEqual({ value: "a x", caret: 3 });
    expect(insertAt("keep drop end", "new", 5, 9)).toEqual({ value: "keep new end", caret: 8 });
  });
});
