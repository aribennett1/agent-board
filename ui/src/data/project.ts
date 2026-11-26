import type { Project } from "./types";
// The project tab: one entry per milestone. "title" is the tab's label and heading; "parent" links the whole project.
// Hidden until a real project is written with `node bin/ab.mjs project-refresh` (title, parent, and at least one
// milestone). Everything between the two marker lines must stay valid JSON.
// Shape (types in ./types.ts):
//   { title, updated_at (ISO UTC), parent: { id, url }, milestones: [{ key, id, title, url, done, in_progress, left, total }] }
//   Counts leave out duplicate and canceled tickets. left includes in_progress, so done + left = total.
//   The "All milestones" line on the page is summed from the milestones; it is not stored here.
export const project: Project =
/* PROJECT-JSON-START */
{
  "title": "",
  "updated_at": "2026-11-24T21:00:00.000Z",
  "parent": {
    "id": "",
    "url": ""
  },
  "milestones": []
}
/* PROJECT-JSON-END */
;
