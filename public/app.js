import { applyBadge, needsHuman } from './badge.js';
import { attachMic } from './mic.js';
import { startBoard, withScroll } from './poll.js';
import { el, renderList, renderNotes } from './render.js';

const $ = (id) => document.getElementById(id);
let selected = null;
let assistant = 'your assistant';

async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

function isIdle() {
  const editing = [...document.querySelectorAll('textarea')].some((t) => document.activeElement === t || t.value.trim());
  return !editing && !document.querySelector('.mic-btn.listening');
}

// A text box with a mic button and a send button. `send(text)` returns a status line.
function composer(label, send) {
  const area = el('textarea', { ariaLabel: label, placeholder: label });
  const status = el('span', { className: 'quiet' });
  const btn = el('button', { type: 'button', className: 'send', textContent: 'Send' });
  const wrap = el('div', { className: 'field' }, area);
  attachMic(area);
  btn.addEventListener('click', async () => {
    const text = area.value.trim();
    if (!text) return;
    btn.disabled = true;
    status.textContent = await send(text);
    btn.disabled = false;
    if (status.textContent.startsWith('Sent')) area.value = '';
  });
  return el('div', {}, wrap, btn, ' ', status);
}

const webhookWords = { sent: 'Sent, and the assistant was woken.', disabled: 'Sent. The wake webhook is not configured.', failed: 'Saved, but the wake webhook failed.' };

function renderThread(json, box = $('thread')) {
  if (!json?.task) {
    box.dataset.id = '';
    box.dataset.notes = '';
    box.replaceChildren(el('p', { className: 'quiet', textContent: 'Task not found.' }));
    return;
  }
  const t = json.task;
  if (box.dataset.id === t.id) {
    const title = box.querySelector('h2');
    const meta = box.querySelector('.thread-meta');
    if (title && title.textContent !== t.title) title.textContent = t.title;
    const line = `${t.state} · owner ${t.owner}`;
    if (meta && meta.textContent !== line) meta.textContent = line;
    renderNotes(box, json.latest);
    return;
  }
  box.dataset.id = t.id;
  box.dataset.notes = '';
  box.replaceChildren(
    el('h2', { textContent: t.title }),
    el('p', { className: 'quiet thread-meta', textContent: `${t.state} · owner ${t.owner}` }),
    el('div', { className: 'thread-hold' }),
    el('h3', { textContent: 'Answer' }),
    composer('Your answer', async (text) => {
      const r = await api(`/api/tasks/${encodeURIComponent(t.id)}/answer`, { body: text });
      if (r.status !== 201) return 'Failed to send.';
      await board.reload();
      return webhookWords[r.json.webhook].replace('the assistant', assistant);
    }),
    el('h3', { textContent: `Message ${assistant}` }),
    composer(`Message ${assistant}`, async (text) => {
      const r = await api(`/api/tasks/${encodeURIComponent(t.id)}/message`, { text });
      return r.json.webhook === 'sent' ? `Sent, and ${assistant} was woken.` : r.json.webhook === 'disabled' ? 'The wake webhook is not configured.' : 'The wake webhook failed.';
    }),
  );
  renderNotes(box, json.latest);
}

function paint({ tasks, thread }) {
  withScroll(window, () => {
    applyBadge(needsHuman(tasks));
    renderList(tasks, $('list'), (id) => {
      selected = id;
      board.reload();
    }, selected);
    if (selected) renderThread(thread);
    $('status').textContent = `updated ${new Date().toLocaleTimeString()}`;
  });
}

const board = startBoard({
  isIdle,
  load: async () => {
    const tasks = (await api('/api/tasks')).json;
    const thread = selected ? await api(`/api/tasks/${encodeURIComponent(selected)}`) : null;
    return { tasks, thread: thread?.status === 200 ? thread.json : (selected ? null : undefined) };
  },
  apply: paint,
});

const cfg = await api('/api/config');
assistant = cfg.json.assistantName ?? assistant;
await board.start();
window.addEventListener('pagehide', () => board.destroy());
