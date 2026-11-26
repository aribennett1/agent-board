// Display settings. The server injects window.__AB_CONFIG__ into index.html; the ACTION_BOARD_* build env is the
// fallback (tests and `vite dev`). The webhook URL and auth never reach the page: the server forwards every send.
type InjectedConfig = { assistantName?: string; timeZone?: string; webhookConfigured?: boolean };
const injected: InjectedConfig = (typeof window !== "undefined" && (window as unknown as { __AB_CONFIG__?: InjectedConfig }).__AB_CONFIG__) || {};

// The assistant's name in the UI: "Message <name>", "Sent to <name>".
export const ASSISTANT_NAME = injected.assistantName?.trim() || import.meta.env.ACTION_BOARD_ASSISTANT_NAME?.trim() || "your assistant";

// The IANA time zone for card stamps, the header date and the project tab's "Last updated".
export const TIME_ZONE = injected.timeZone?.trim() || import.meta.env.ACTION_BOARD_TIMEZONE?.trim() || "America/New_York";

// Whether the server has a wake webhook. Without one, sends stay pending and the header says so.
export const WEBHOOK_CONFIGURED = injected.webhookConfigured ?? import.meta.env.ACTION_BOARD_WEBHOOK_CONFIGURED === "1";
