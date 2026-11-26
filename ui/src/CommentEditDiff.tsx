import { commentDiff, type DiffRow, type WordSeg } from "./commentDiff";

function Segs({ segs }: { segs: WordSeg[] }) {
  return (
    <>
      {segs.map((s, i) =>
        s.kind === "same" ? (
          <span key={i}>{s.text}</span>
        ) : (
          <span key={i} className={`edit-diff-word ${s.kind}`}>
            {s.text}
          </span>
        ),
      )}
    </>
  );
}

function Row({ row }: { row: DiffRow }) {
  if (row.kind === "omit") {
    return (
      <div className="edit-diff-omit" role="note">
        {row.count === 1 ? "1 unchanged line hidden" : `${row.count} unchanged lines hidden`}
      </div>
    );
  }
  if (row.kind === "same") {
    return (
      <div className="edit-diff-line same">
        <span className="edit-diff-gutter" aria-hidden="true">
          {" "}
        </span>
        <span className="edit-diff-code">{row.text || " "}</span>
      </div>
    );
  }
  return (
    <div className={`edit-diff-line ${row.kind}`}>
      <span className="edit-diff-gutter" aria-hidden="true">
        {row.kind === "del" ? "−" : "+"}
      </span>
      <span className="edit-diff-code">
        <Segs segs={row.segs} />
        {row.segs.length === 0 ? " " : null}
      </span>
    </div>
  );
}

export function CommentEditDiff({ before, after }: { before: string; after: string }) {
  const rows = commentDiff(before, after);
  const changed = rows.some((r) => r.kind === "del" || r.kind === "ins");
  return (
    <section className="edit-diff-block" aria-label="What changes in the comment">
      <div className="post-approval-head">
        <span className="post-approval-kicker">What changes</span>
        <span className="edit-diff-legend" aria-hidden="true">
          <span className="edit-diff-legend-del">now</span>
          <span className="edit-diff-legend-ins">new</span>
        </span>
      </div>
      {changed ? (
        <div className="edit-diff" role="region" aria-label="Diff of the posted text and the new text">
          {rows.map((row, i) => (
            <Row key={i} row={row} />
          ))}
        </div>
      ) : (
        <p className="edit-diff-same">The new text matches what's already posted.</p>
      )}
    </section>
  );
}
