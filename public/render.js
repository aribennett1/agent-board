// In-place board rendering: change only the rows and notes that moved, leave the rest alone.

export function el(tag, props = {}, ...kids) {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids);
  return n;
}

export function taskClass(t, selected) {
  const needs = (t.owner === 'human' && t.state !== 'done' && t.state !== 'merged') || t.open_cards > 0;
  return `task${t.id === selected ? ' selected' : ''}${needs ? ' needs' : ''}`;
}

/** Update the task list in place: change labels and classes that moved, leave the rest alone. */
export function renderList(tasks, list, onSelect, selected, make = el) {
  if (!tasks.length) {
    if (list.dataset.empty !== '1') list.replaceChildren(make('p', { className: 'quiet', textContent: 'No tasks yet.' }));
    list.dataset.empty = '1';
    return;
  }
  if (list.dataset.empty === '1') list.replaceChildren();
  list.dataset.empty = '0';
  const existing = new Map([...list.querySelectorAll('button.task')].map((b) => [b.dataset.id, b]));
  const used = new Set();
  tasks.forEach((t, i) => {
    let b = existing.get(t.id);
    if (!b) {
      b = make('button', { type: 'button' });
      b.dataset.id = t.id;
      b.addEventListener('click', () => onSelect?.(t.id));
    }
    used.add(t.id);
    const label = `${t.title} (${t.state})`;
    const cls = taskClass(t, selected);
    if (b.textContent !== label) b.textContent = label;
    if (b.className !== cls) b.className = cls;
    const at = list.children[i];
    if (at !== b) list.insertBefore(b, at ?? null);
  });
  for (const [id, b] of existing) if (!used.has(id)) b.remove();
}

export function notesKey(latest) {
  return JSON.stringify((latest ?? []).map((n) => [n.id, n.author, n.kind, n.body]));
}

export function renderNotes(box, latest, make = el) {
  const key = notesKey(latest);
  if (box.dataset.notes === key) return false;
  box.dataset.notes = key;
  const hold = box.querySelector('.thread-hold');
  hold.replaceChildren(
    ...(latest ?? []).map((n) => make('div', { className: `note ${n.author}` }, make('small', { textContent: `${n.author} · ${n.kind}` }), make('div', { textContent: n.body }))),
  );
  return true;
}
