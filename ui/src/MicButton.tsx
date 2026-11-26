import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

// Voice to text for any board text field, through the browser's Web Speech API. Click once to start listening (the
// icon turns red and pulses), click again to stop. Heard text is inserted at the field's cursor and never sent.
// Renders nothing when the browser has no speech recognition.

type Field = HTMLTextAreaElement | HTMLInputElement;

type Alternative = { transcript: string };
type Result = { isFinal: boolean; 0: Alternative; length: number };
type RecognitionEvent = { resultIndex: number; results: ArrayLike<Result> };
export type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: RecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type RecognitionCtor = new () => Recognition;

export function speechRecognition(): RecognitionCtor | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

// The field value with `heard` inserted over the selection [start, end), spaced from its neighbours.
export function insertAt(
  value: string,
  heard: string,
  start: number,
  end: number,
): { value: string; caret: number } {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const text = heard.trim();
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^\s/.test(after) ? " " : "";
  const insert = lead + text + trail;
  return {
    value: before + insert + after,
    caret: before.length + lead.length + text.length,
  };
}

export function MicButton({
  field,
  value,
  onChange,
  disabled = false,
}: {
  field: RefObject<Field | null>;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const [Ctor] = useState(speechRecognition);
  const [listening, setListening] = useState(false);
  const rec = useRef<Recognition | null>(null);
  const latest = useRef({ value, onChange });
  const session = useRef({ base: "", start: 0, end: 0, lastSet: "" });
  latest.current = { value, onChange };

  // Caret to place after the inserted text, once the new value has rendered.
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const f = field.current;
    if (f && caret.current !== null) {
      f.focus();
      f.setSelectionRange(caret.current, caret.current);
    }
    caret.current = null;
  }, [value, field]);

  useEffect(() => () => rec.current?.abort(), []);

  if (!Ctor)
    return (
      <span
        className="mic-hint"
        role="img"
        aria-label="Voice typing isn't supported in this browser. Use Chrome or Safari, or type your answer."
        title="Voice typing isn't supported in this browser. Use Chrome or Safari, or type your answer."
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M5 11a7 7 0 0 0 14 0M12 18v3M3 3l18 18" />
        </svg>
      </span>
    );

  // One listening session: the text around the words being heard. Interim words show live in the field and are
  // replaced as they firm up; a final result is committed and becomes part of the base. If the owner types meanwhile,
  // the session re-bases on his text at the cursor.
  const selection = (cur: string) => {
    const el = field.current;
    const active = el && document.activeElement === el;
    return {
      start: active && el.selectionStart != null ? el.selectionStart : cur.length,
      end: active && el.selectionEnd != null ? el.selectionEnd : cur.length,
    };
  };
  const show = (heard: string, final: boolean) => {
    const ses = session.current;
    const cur = latest.current.value;
    if (cur !== ses.lastSet) {
      const sel = selection(cur);
      Object.assign(ses, { base: cur, start: sel.start, end: sel.end });
    }
    const next = heard.trim() ? insertAt(ses.base, heard, ses.start, ses.end) : { value: ses.base, caret: ses.start };
    ses.lastSet = next.value;
    if (final) Object.assign(ses, { base: next.value, start: next.caret, end: next.caret });
    if (next.value === cur) return;
    latest.current = { ...latest.current, value: next.value };
    caret.current = next.caret;
    latest.current.onChange(next.value);
  };

  const stop = () => {
    rec.current?.stop();
    rec.current = null;
    setListening(false);
  };

  const start = () => {
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = "en-US";
    const cur = latest.current.value;
    const sel = selection(cur);
    session.current = { base: cur, start: sel.start, end: sel.end, lastSet: cur };
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) show(res[0].transcript, true);
        else interim += res[0].transcript;
      }
      show(interim, false);
    };
    r.onend = () => {
      if (rec.current === r) rec.current = null;
      setListening(false);
    };
    r.onerror = () => {
      if (rec.current === r) rec.current = null;
      setListening(false);
    };
    rec.current = r;
    try {
      r.start();
      setListening(true);
    } catch {
      rec.current = null;
    }
  };

  return (
    <button
      type="button"
      className={`mic-btn${listening ? " listening" : ""}`}
      aria-label={listening ? "Stop voice typing" : "Voice typing"}
      aria-pressed={listening}
      title={listening ? "Stop voice typing" : "Voice typing"}
      disabled={disabled && !listening}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => (listening ? stop() : start())}
    >
      <svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="9" y="3" width="6" height="11" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
      </svg>
    </button>
  );
}
