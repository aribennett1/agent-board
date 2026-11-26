import type { Board } from "./types";
// Empty seed. The live board comes from the server's SQLite store at /__ab/board.
export const board: Board =
/* BOARD-JSON-START */
{
  "updated_at": "1970-01-01T00:00:00.000Z",
  "decisions": [],
  "glance": { "waiting": [], "tickets": [], "others": [], "mine": [] }
}
/* BOARD-JSON-END */
;
