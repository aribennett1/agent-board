-- Idempotent: open() runs this on every start.

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  ticket TEXT,
  pr INTEGER,
  state TEXT NOT NULL CHECK (state IN ('planning','plan_review','building','qa_review','waiting_human','merged','done')),
  -- bumps on each new push (engineer) or new plan version (planner)
  cycle INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS tasks_pr ON tasks(pr);
CREATE INDEX IF NOT EXISTS tasks_ticket ON tasks(ticket);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  author TEXT NOT NULL CHECK (author IN ('planner','engineer','qa','ops','chief','human','script')),
  kind TEXT NOT NULL CHECK (kind IN ('started','answer','question','work','review_pass','review_changes','pass_through','info')),
  body TEXT NOT NULL,
  supersedes_id INTEGER REFERENCES notes(id),
  -- task cycle when written; hop limits count review rounds per cycle
  cycle INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS notes_task ON notes(task_id, author, kind);
CREATE INDEX IF NOT EXISTS notes_supersedes ON notes(supersedes_id);

CREATE TRIGGER IF NOT EXISTS notes_no_update BEFORE UPDATE ON notes
BEGIN SELECT RAISE(ABORT, 'notes are append-only'); END;

CREATE TRIGGER IF NOT EXISTS notes_no_delete BEFORE DELETE ON notes
BEGIN SELECT RAISE(ABORT, 'notes are append-only'); END;

-- An edit is a new row; only the same author on the same task may supersede.
CREATE TRIGGER IF NOT EXISTS notes_supersede_author BEFORE INSERT ON notes
WHEN NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM notes WHERE id = NEW.supersedes_id AND author = NEW.author AND task_id = NEW.task_id
)
BEGIN SELECT RAISE(ABORT, 'wrong author'); END;

CREATE VIEW IF NOT EXISTS notes_latest AS
SELECT * FROM notes n WHERE NOT EXISTS (SELECT 1 FROM notes s WHERE s.supersedes_id = n.id);

CREATE TABLE IF NOT EXISTS state_changes (
  id INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  by TEXT NOT NULL CHECK (by IN ('planner','engineer','qa','ops','chief','human','script')),
  cycle INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS state_changes_task ON state_changes(task_id, id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  source TEXT NOT NULL CHECK (source IN ('human','bot','github','linear','script')),
  type TEXT NOT NULL,
  dedup_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  processed_at TEXT
);
CREATE INDEX IF NOT EXISTS events_pending ON events(task_id) WHERE processed_at IS NULL;

CREATE TABLE IF NOT EXISTS wakes (
  id INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  bot TEXT NOT NULL,
  reason TEXT NOT NULL,
  event_ids TEXT NOT NULL DEFAULT '[]',
  cycle INTEGER NOT NULL,
  rewake_of INTEGER REFERENCES wakes(id),
  sent_at TEXT NOT NULL,
  send_ok INTEGER,
  checkin_at TEXT,
  done_at TEXT,
  outcome TEXT CHECK (outcome IN ('real_work','pass_through','nothing')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS wakes_open ON wakes(task_id, bot) WHERE done_at IS NULL;

CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL CHECK (kind IN ('hop_limit','no_checkin','stuck','wake_failed','drift','question')),
  body TEXT NOT NULL,
  -- the wake a liveness card is about; lets checks skip wakes already carded
  wake_id INTEGER REFERENCES wakes(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS cards_task ON cards(task_id, kind);

CREATE TABLE IF NOT EXISTS drift_checks (
  id INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  db_state TEXT NOT NULL,
  linear TEXT NOT NULL,
  github TEXT NOT NULL,
  mismatch INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
