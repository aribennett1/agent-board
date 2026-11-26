import type { Ask } from "./data/types";

// WhatsApp-style receipt next to the human's own messages: one gray check = saved (sent from the browser), two gray =
// delivered (the wake webhook took it), two blue = read (the assistant ran ab answer, ab reply or ab read on the item).
export type CheckStatus = NonNullable<Ask["status"]>;
const LABEL: Record<CheckStatus, string> = { sent: "Sent", delivered: "Delivered", read: "Read by the assistant" };

export function Checks({ status = "sent" }: { status?: CheckStatus }) {
  return (
    <span className={`checks checks-${status}`} role="img" aria-label={LABEL[status]} title={LABEL[status]}>
      {status === "sent" ? "✓" : "✓✓"}
    </span>
  );
}
