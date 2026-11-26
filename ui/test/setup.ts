// jsdom does not implement scrolling; the board scrolls to the top after an answer, so give it a no-op.
if (typeof window !== "undefined") window.scrollTo = (() => undefined) as typeof window.scrollTo;
