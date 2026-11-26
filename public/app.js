import { applyBadge, needsHuman } from './badge.js';
import { attachMic } from './mic.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids);
  return n;
};
let selected = null;
let assistant = 'your assistant';

async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  return { status: r.status, json: await r.json().catch(() => ({})) };
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

async function drawThread(id) {
  const { status, json } = await api(`/api/tasks/${encodeURIComponent(id)}`);
  const box = $('thread');
  if (status !== 200) return box.replaceChildren(el('p', { className: 'quiet', textContent: 'Task not found.' }));
  const keep = box.querySelector('textarea') && box.dataset.id === id;
  if (keep) return; // never replace a thread while the human is typing in it
  box.dataset.id = id;
  box.replaceChildren(
    el('h2', { textContent: json.task.title }),
    el('p', { className: 'quiet', textContent: `${json.task.state} · owner ${json.task.owner}` }),
    ...json.latest.map((n) => el('div', { className: `note ${n.author}` }, el('small', { textContent: `${n.author} · ${n.kind}` }), el('div', { textContent: n.body }))),
    el('h3', { textContent: 'Answer' }),
    composer('Your answer', async (text) => {
      const r = await api(`/api/tasks/${encodeURIComponent(id)}/answer`, { body: text });
      if (r.status !== 201) return 'Failed to send.';
      box.dataset.id = '';
      refresh();
      return webhookWords[r.json.webhook].replace('the assistant', assistant);
    }),
    el('h3', { textContent: `Message ${assistant}` }),
    composer(`Message ${assistant}`, async (text) => {
      const r = await api(`/api/tasks/${encodeURIComponent(id)}/message`, { text });
      return r.json.webhook === 'sent' ? `Sent, and ${assistant} was woken.` : r.json.webhook === 'disabled' ? 'The wake webhook is not configured.' : 'The wake webhook failed.';
    }),
  );
}

async function refresh() {
  const { json: tasks } = await api('/api/tasks');
  applyBadge(needsHuman(tasks));
  const list = $('list');
  list.replaceChildren(...(tasks.length ? tasks : []).map((t) => {
    const b = el('button', { type: 'button', className: `task${t.id === selected ? ' selected' : ''}${t.owner === 'human' && t.state !== 'done' && t.state !== 'merged' ? ' needs' : ''}`, textContent: `${t.title} (${t.state})` });
    b.addEventListener('click', () => {
      selected = t.id;
      $('thread').dataset.id = '';
      refresh();
    });
    return b;
  }));
  if (!tasks.length) list.replaceChildren(el('p', { className: 'quiet', textContent: 'No tasks yet.' }));
  $('status').textContent = `updated ${new Date().toLocaleTimeString()}`;
  if (selected) await drawThread(selected);
}

const cfg = await api('/api/config');
assistant = cfg.json.assistantName ?? assistant;
refresh();
setInterval(refresh, 5000);
