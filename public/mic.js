// Voice to text for a board text field via the browser's Web Speech API. Click once to listen (the icon turns red and
// pulses), click again to stop. Heard text is inserted at the cursor and never sent. Shows a hint when unsupported.

export function speechRecognition(win = window) {
  return win.SpeechRecognition ?? win.webkitSpeechRecognition;
}

/** The field value with `heard` inserted over [start, end), spaced from its neighbours. */
export function insertAt(value, heard, start, end) {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const text = heard.trim();
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const trail = after && !/^\s/.test(after) ? ' ' : '';
  return { value: before + lead + text + trail + after, caret: before.length + lead.length + text.length };
}

const ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
const HINT = "Voice typing isn't supported in this browser. Use Chrome or Safari, or type your answer.";

/** Add a mic button next to `field` (a textarea or input). Returns the element, or null when unsupported. */
export function attachMic(field, win = window) {
  const doc = field.ownerDocument;
  const Ctor = speechRecognition(win);
  if (!Ctor) {
    const hint = doc.createElement('span');
    hint.className = 'mic-hint';
    hint.title = HINT;
    hint.setAttribute('role', 'img');
    hint.setAttribute('aria-label', HINT);
    hint.innerHTML = ICON.replace('<path d="M5', '<path d="M3 3l18 18M5');
    field.after(hint);
    return null;
  }
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = 'mic-btn';
  btn.innerHTML = ICON;
  let rec = null;
  let ses = { base: '', start: 0, end: 0, lastSet: '' };
  const label = (on) => {
    btn.classList.toggle('listening', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', on ? 'Stop voice typing' : 'Voice typing');
    btn.title = on ? 'Stop voice typing' : 'Voice typing';
  };
  label(false);
  const sel = () => {
    const active = doc.activeElement === field;
    return { start: active ? field.selectionStart : field.value.length, end: active ? field.selectionEnd : field.value.length };
  };
  const show = (heard, final) => {
    const cur = field.value;
    if (cur !== ses.lastSet) ses = { base: cur, ...sel(), lastSet: ses.lastSet }; // the user typed: re-base on their text
    const next = heard.trim() ? insertAt(ses.base, heard, ses.start, ses.end) : { value: ses.base, caret: ses.start };
    ses.lastSet = next.value;
    if (final) ses = { base: next.value, start: next.caret, end: next.caret, lastSet: next.value };
    if (next.value === cur) return;
    field.value = next.value;
    field.setSelectionRange(next.caret, next.caret);
    field.dispatchEvent(new win.Event('input', { bubbles: true }));
  };
  const done = (r) => () => {
    if (rec === r) rec = null;
    label(false);
  };
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => {
    if (rec) {
      rec.stop();
      rec = null;
      label(false);
      return;
    }
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = 'en-US';
    ses = { base: field.value, ...sel(), lastSet: field.value };
    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) show(e.results[i][0].transcript, true);
        else interim += e.results[i][0].transcript;
      }
      show(interim, false);
    };
    r.onend = done(r);
    r.onerror = done(r);
    rec = r;
    try {
      r.start();
      label(true);
    } catch {
      rec = null;
    }
  });
  field.after(btn);
  return btn;
}
