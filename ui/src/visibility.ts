import type { Decision } from "./data/types";
import { isActionable, type StaleContext } from "./triage";

// A decision needs the user iff it is still an open ask: no answer on file or in the app,
// and it has not been superseded or marked stale (SHA moved, or the thing already happened).
export function needsYou(
  decisions: Decision[],
  appAnswered: Record<string, unknown>,
  ctx: StaleContext = {},
): Decision[] {
  return decisions.filter((d) => isActionable(d, ctx, appAnswered));
}
