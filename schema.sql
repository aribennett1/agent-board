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

-- Action board UI store. The board document (decisions, asks, glance, details, reviews, briefs) and the project tab
-- are JSON documents written by bin/ab.mjs; tasks and cards above are merged in as decisions when served.
CREATE TABLE IF NOT EXISTS ui_doc (
  key TEXT PRIMARY KEY CHECK (key IN ('board','project')),
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- "Not relevant anymore" and ab clear keep the card here so ab restore can bring it back. Append-only.
CREATE TABLE IF NOT EXISTS ui_tombstones (
  id INTEGER PRIMARY KEY,
  card_id TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS ui_log (
  id INTEGER PRIMARY KEY,
  json TEXT NOT NULL
);
-- One row per webhook POST attempt the browser reports, without the URL, auth value or message text.
CREATE TABLE IF NOT EXISTS ui_delivery_log (
  id INTEGER PRIMARY KEY,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- Webhook message ids already delivered, so a retried "Message the assistant" is never sent twice.
CREATE TABLE IF NOT EXISTS ui_delivered (
  message_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- Board-side state for decisions derived from tasks and cards (task:<id>:<note>, card:<id>).
CREATE TABLE IF NOT EXISTS ui_derived_state (
  decision_id TEXT PRIMARY KEY,
  priority TEXT CHECK (priority IN ('high','medium','low')),
  cleared_at TEXT,
  answered_at TEXT
);
-- Receipts for the human's messages (the checks next to them). Delivered: the wake webhook answered 2xx for that ask id.
-- Read: the assistant ran ab answer, ab reply or ab read on the item; every ask on it sent at or before read_at counts as read.
CREATE TABLE IF NOT EXISTS ui_ask_delivered (
  ask_id TEXT PRIMARY KEY,
  delivered_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ui_item_read (
  item_key TEXT PRIMARY KEY,
  read_at TEXT NOT NULL
);

-- Status notes from the bots (ab notify). Clearing one never wakes a bot.
CREATE TABLE IF NOT EXISTS ui_notifications (
  id INTEGER PRIMARY KEY,
  bot TEXT NOT NULL,
  text TEXT NOT NULL,
  next_update TEXT,
  link TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  cleared_at TEXT
);

-- Tickets and PRs for My tickets, My PRs and Others' PRs: fetched by the board server itself (src/feed.ts), never written by a bot.
CREATE TABLE IF NOT EXISTS ui_feed (
  key TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Daily prune (ab prune): old closed cards and their asks and details, old log rows and cleared notifications are
-- moved here, never deleted. GET /__ab/archive reads them back.
CREATE TABLE IF NOT EXISTS archive_cards (
  card_id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  details_json TEXT,
  answered_at TEXT,
  archived_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS archive_asks (
  ask_id TEXT PRIMARY KEY,
  item_key TEXT NOT NULL,
  at TEXT NOT NULL,
  json TEXT NOT NULL,
  archived_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS archive_asks_item ON archive_asks(item_key, at);
CREATE TABLE IF NOT EXISTS archive_ui_log (
  id INTEGER PRIMARY KEY,
  json TEXT NOT NULL,
  archived_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS archive_ui_delivery_log (
  id INTEGER PRIMARY KEY,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  archived_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS archive_ui_notifications (
  id INTEGER PRIMARY KEY,
  bot TEXT NOT NULL,
  text TEXT NOT NULL,
  next_update TEXT,
  link TEXT,
  created_at TEXT NOT NULL,
  cleared_at TEXT,
  archived_at TEXT NOT NULL
);

-- My PRs that need work (changes requested, failing checks, open reviewer threads) while no open card names them.
-- src/attention.ts writes a notification once a PR has gone GRACE_MS like that, and clears it when a card appears or the work is done.
CREATE TABLE IF NOT EXISTS pr_attention (
  pr TEXT PRIMARY KEY,
  sig TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  notification_id INTEGER
);
