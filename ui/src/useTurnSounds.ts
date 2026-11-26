import { useEffect, useRef, useSyncExternalStore } from "react";
import { newTurnItems, soundPlayer, type SoundPlayer, type TurnItem } from "./sounds";

/**
 * Plays the raising bot's sound for each item that newly becomes Eric's turn.
 * Items present when the page first has live data (and anything seen before) never sound.
 * `ready` is false until the first poll has landed, so the bundled snapshot never counts as "new".
 */
export function useTurnSounds(items: TurnItem[], ready: boolean, player: SoundPlayer = soundPlayer()) {
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!ready) return;
    if (!seen.current) {
      seen.current = new Set(items.map((i) => i.key));
      return;
    }
    const fresh = newTurnItems(seen.current, items);
    for (const i of fresh) {
      seen.current.add(i.key);
      player.play(i.bot);
    }
  });
  // The first click, tap or key unlocks audio and speech.
  useEffect(() => {
    const go = () => player.unlock();
    const opts = { once: true, capture: true } as const;
    const evs = ["pointerdown", "keydown", "click"] as const;
    for (const e of evs) document.addEventListener(e, go, opts);
    return () => { for (const e of evs) document.removeEventListener(e, go, opts); };
  }, [player]);
}

export function useMuted(player: SoundPlayer = soundPlayer()): boolean {
  return useSyncExternalStore(player.subscribe, player.isMuted, player.isMuted);
}
