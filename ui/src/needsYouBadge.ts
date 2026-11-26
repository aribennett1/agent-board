import { useEffect } from "react";

const BASE_TITLE = "Action Board";
const NEEDS_TITLE = "● Action Board";
const BASE_ICON = "/favicon.svg";
const NEEDS_ICON = "/favicon-needs.svg";

function iconLink(): HTMLLinkElement | null {
  return document.querySelector("link[rel='icon']");
}

// Swap the favicon and tab title when something on the board still needs the owner.
// Runs off the same live board data as the rest of the app, so it updates without a reload.
export function useNeedsYouBadge(needsYou: boolean) {
  useEffect(() => {
    const icon = iconLink();
    if (needsYou) {
      if (icon) icon.href = NEEDS_ICON;
      document.title = NEEDS_TITLE;
    } else {
      if (icon) icon.href = BASE_ICON;
      document.title = BASE_TITLE;
    }
  }, [needsYou]);
}

export const badgeTitle = { base: BASE_TITLE, needs: NEEDS_TITLE, baseIcon: BASE_ICON, needsIcon: NEEDS_ICON };
