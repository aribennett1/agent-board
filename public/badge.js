// Red-dot notification: swap the favicon and tab title while anything on the board waits for the human.
export const BASE_TITLE = 'Agent Board';
export const NEEDS_TITLE = '● Agent Board';
export const BASE_ICON = '/favicon.svg';
export const NEEDS_ICON = '/favicon-needs.svg';

/** A task needs the human when it is the human's turn or it has an unresolved card. */
export function needsHuman(tasks) {
  return tasks.some((t) => (t.owner === 'human' && t.state !== 'merged' && t.state !== 'done') || t.open_cards > 0);
}

export function applyBadge(needs, doc = document) {
  const icon = doc.querySelector("link[rel='icon']");
  if (icon) icon.href = needs ? NEEDS_ICON : BASE_ICON;
  doc.title = needs ? NEEDS_TITLE : BASE_TITLE;
}
