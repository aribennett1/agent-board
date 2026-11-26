import type { OtherPR } from "./data/types";

// Items waiting on the user's review come first; each group keeps the file's order.
export function sortOthers(items: OtherPR[]): OtherPR[] {
  return [...items.filter(isReviewRequest), ...items.filter((o) => !isReviewRequest(o))];
}

// A PR that waits on the user's review.
export const isReviewRequest = (o: OtherPR) => /review requested/i.test(o.who);

// "app #209" from a GitHub pull request URL; undefined for any other link.
export function prRef(link: string | undefined): string | undefined {
  const m = link?.match(/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/);
  return m ? `${m[1]} #${m[2]}` : undefined;
}

// "app/209" from a GitHub pull request URL (the item's focus id); undefined for any other link.
export function prPath(link: string | undefined): string | undefined {
  const m = link?.match(/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/);
  return m ? `${m[1]}/${m[2]}` : undefined;
}
