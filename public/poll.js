// Board auto-refresh, same shape as the Zeidy-D PDF reader: poll a small version endpoint, and only
// fetch and swap content when the hash changes. Checks never overlap, never clobber a field being
// edited or a live mic, and they stop on teardown.

export const POLL_MS = 10_000;
export const VERSION_RE = /^[a-f0-9]{64}$/;

export async function versionInfo(fetchImpl = fetch, url = '/api/version') {
  const res = await fetchImpl(`${url}?check=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('Version check failed');
  const info = await res.json();
  if (!VERSION_RE.test(info.version)) throw new Error('Invalid board version');
  return info;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Snapshot and restore window and overflow-scroll positions around a DOM update. */
export function withScroll(root, fn) {
  const y = root.scrollY ?? 0;
  const scope = root.document ?? root;
  const parts = [...(scope.querySelectorAll?.('[data-scroll]') ?? [])].map((el) => [el, el.scrollTop]);
  fn();
  if (typeof root.scrollTo === 'function') root.scrollTo(0, y);
  else root.scrollY = y;
  for (const [el, top] of parts) el.scrollTop = top;
}

/**
 * Poll `versionUrl` every `intervalMs` (default 10s) and whenever the tab becomes visible.
 * `load` fetches the board data; `apply` paints only what changed; `isIdle` must be false while a
 * text field is being edited or the mic is recording.
 */
/**
 * @param {{
 *   load: () => Promise<any>,
 *   apply: (data: any) => void,
 *   isIdle?: () => boolean,
 *   fetchImpl?: typeof fetch,
 *   versionUrl?: string,
 *   intervalMs?: number,
 *   document?: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>,
 *   setIntervalFn?: (fn: () => void, ms: number) => unknown,
 *   clearIntervalFn?: (id: unknown) => void,
 *   wait?: (ms: number) => Promise<void>,
 * }} [opts]
 */
export function startBoard({
  load,
  apply,
  isIdle = () => true,
  fetchImpl = fetch,
  versionUrl = '/api/version',
  intervalMs = POLL_MS,
  document: doc = document,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  wait = delay,
} = {}) {
  const state = { version: undefined, busy: false, dead: false, timer: undefined, generation: 0 };

  async function idle() {
    while (!state.dead && !isIdle()) await wait(50);
  }

  async function checkVersion() {
    if (state.busy || state.dead) return;
    state.busy = true;
    try {
      const info = await versionInfo(fetchImpl, versionUrl);
      if (info.version === state.version) return;
      await idle();
      if (state.dead) return;
      const g = state.generation;
      const data = await load();
      await idle();
      if (state.dead || g !== state.generation) return;
      apply(data);
      state.version = info.version;
    } catch (e) {
      if (!state.dead) console.warn('Board update postponed', e);
    } finally {
      state.busy = false;
    }
  }

  async function reload() {
    state.generation++;
    const g = state.generation;
    const [info, data] = await Promise.all([versionInfo(fetchImpl, versionUrl), load()]);
    if (state.dead || g !== state.generation) return;
    apply(data);
    state.version = info.version;
  }

  const onVisibility = () => {
    if (!doc.hidden) checkVersion();
  };

  async function start() {
    await checkVersion();
    if (state.dead) return;
    state.timer = setIntervalFn(() => checkVersion(), intervalMs);
    doc.addEventListener('visibilitychange', onVisibility);
  }

  function destroy() {
    if (state.dead) return;
    state.dead = true;
    clearIntervalFn(state.timer);
    doc.removeEventListener('visibilitychange', onVisibility);
  }

  return { state, start, checkVersion, reload, destroy };
}
