// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useNeedsYouBadge, badgeTitle } from "../src/needsYouBadge";
import { isClarifying } from "../src/topics";

afterEach(() => cleanup());

function Badge({ needsYou }: { needsYou: boolean }) {
  useNeedsYouBadge(needsYou);
  return <span>ok</span>;
}

describe("isClarifying", () => {
  it("treats a follow-up that contains a question as clarifying, even if it does not end with ?", () => {
    expect(isClarifying("This PR already exists. what are you changing in the existing PR? doesn't it already work that way")).toBe(true);
    expect(isClarifying("Yes, push")).toBe(false);
    expect(isClarifying("See https://github.com/acme/example-repo/pull/2014")).toBe(false);
  });
});

describe("needs-you tab badge", () => {
  it("puts a red-dot favicon and a dot in the title when something needs the owner, and restores them when nothing does", () => {
    document.head.innerHTML = '<link rel="icon" href="/favicon.svg">';
    document.title = "Action Board";
    const { rerender } = render(<Badge needsYou={true} />);
    expect(document.title).toBe(badgeTitle.needs);
    expect((document.querySelector("link[rel='icon']") as HTMLLinkElement).getAttribute("href")).toBe(badgeTitle.needsIcon);
    rerender(<Badge needsYou={false} />);
    expect(document.title).toBe(badgeTitle.base);
    expect((document.querySelector("link[rel='icon']") as HTMLLinkElement).getAttribute("href")).toBe(badgeTitle.baseIcon);
  });
});
