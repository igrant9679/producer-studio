// Idempotent schema creation + a schema_version table for later migrations. Runs identically on PGlite and Postgres.
export const SCHEMA_VERSION = 11

export const DDL_V1 = `
CREATE TABLE IF NOT EXISTS schema_version (id integer PRIMARY KEY, version integer NOT NULL, updated_at double precision NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  avatar_color text NOT NULL,
  created_at double precision NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at double precision NOT NULL,
  created_at double precision NOT NULL,
  user_agent text
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

CREATE TABLE IF NOT EXISTS workspaces (
  id text PRIMARY KEY,
  name text NOT NULL,
  personal boolean NOT NULL DEFAULT false,
  created_by text NOT NULL,
  created_at double precision NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL,
  created_at double precision NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships(user_id);

CREATE TABLE IF NOT EXISTS invites (
  token text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL,
  created_by text NOT NULL,
  created_at double precision NOT NULL,
  accepted_at double precision,
  accepted_by text
);

CREATE TABLE IF NOT EXISTS projects (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'edit',
  doc jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1,
  thumbnail text,
  duration double precision NOT NULL DEFAULT 0,
  width integer NOT NULL,
  height integer NOT NULL,
  is_template boolean NOT NULL DEFAULT false,
  trashed_at double precision,
  created_by text NOT NULL,
  created_at double precision NOT NULL,
  updated_at double precision NOT NULL
);
CREATE INDEX IF NOT EXISTS projects_ws_idx ON projects(workspace_id, updated_at);

CREATE TABLE IF NOT EXISTS assets (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id text,
  kind text NOT NULL,
  name text NOT NULL,
  mime text NOT NULL,
  size double precision NOT NULL DEFAULT 0,
  status text NOT NULL,
  origin text NOT NULL DEFAULT 'upload',
  error text,
  source_key text NOT NULL,
  proxy_key text,
  thumb_key text,
  filmstrip_key text,
  audio_key text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL,
  created_at double precision NOT NULL,
  updated_at double precision NOT NULL
);
CREATE INDEX IF NOT EXISTS assets_ws_idx ON assets(workspace_id, created_at);

CREATE TABLE IF NOT EXISTS jobs (
  id text PRIMARY KEY,
  kind text NOT NULL,
  status text NOT NULL,
  progress double precision NOT NULL DEFAULT 0,
  message text NOT NULL DEFAULT '',
  input jsonb NOT NULL,
  result jsonb,
  error text,
  project_id text,
  workspace_id text NOT NULL,
  user_id text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  cancel_requested boolean NOT NULL DEFAULT false,
  locked_by text,
  locked_at double precision,
  created_at double precision NOT NULL,
  updated_at double precision NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs(status, created_at);
CREATE INDEX IF NOT EXISTS jobs_ws_idx ON jobs(workspace_id, created_at);

CREATE TABLE IF NOT EXISTS exports (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  workspace_id text NOT NULL,
  asset_id text NOT NULL,
  job_id text,
  name text NOT NULL,
  resolution text NOT NULL,
  fps integer NOT NULL,
  format text NOT NULL,
  size_bytes double precision NOT NULL,
  duration double precision NOT NULL,
  created_by text NOT NULL,
  created_at double precision NOT NULL
);
CREATE INDEX IF NOT EXISTS exports_project_idx ON exports(project_id, created_at);

CREATE TABLE IF NOT EXISTS share_links (
  token text PRIMARY KEY,
  project_id text NOT NULL,
  export_id text,
  created_by text NOT NULL,
  created_at double precision NOT NULL
);

CREATE TABLE IF NOT EXISTS brand_kits (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  doc jsonb NOT NULL,
  updated_at double precision NOT NULL
);
`

/**
 * v2 — desktop/cloud sync: server-wide change feed (change_seq on synced tables, set by triggers so every write
 * path bumps it), tombstones for hard deletes, asset sha256, device tokens.
 */
export const DDL_V2 = `
CREATE SEQUENCE IF NOT EXISTS change_seq;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS change_seq bigint;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS change_seq bigint;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS sha256 text;
ALTER TABLE brand_kits ADD COLUMN IF NOT EXISTS change_seq bigint;
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS change_seq bigint;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS change_seq bigint;

CREATE TABLE IF NOT EXISTS tombstones (
  kind text NOT NULL,
  id text NOT NULL,
  workspace_id text NOT NULL,
  change_seq bigint NOT NULL,
  deleted_at double precision NOT NULL
);
CREATE INDEX IF NOT EXISTS tombstones_seq_idx ON tombstones(workspace_id, change_seq);

CREATE TABLE IF NOT EXISTS devices (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  created_at double precision NOT NULL,
  last_seen_at double precision
);
CREATE INDEX IF NOT EXISTS devices_user_idx ON devices(user_id);

CREATE OR REPLACE FUNCTION ps_bump_change_seq() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.change_seq := nextval('change_seq');
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION ps_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO tombstones (kind, id, workspace_id, change_seq, deleted_at)
  VALUES (TG_ARGV[0], OLD.id, OLD.workspace_id, nextval('change_seq'), extract(epoch from clock_timestamp()) * 1000);
  RETURN OLD;
END $$;

-- joining a workspace republishes its content so the new member's replicas receive it
CREATE OR REPLACE FUNCTION ps_membership_joined() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE projects SET change_seq = 0 WHERE workspace_id = NEW.workspace_id;
  UPDATE assets SET change_seq = 0 WHERE workspace_id = NEW.workspace_id;
  UPDATE brand_kits SET change_seq = 0 WHERE workspace_id = NEW.workspace_id;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS projects_change_seq ON projects;
CREATE TRIGGER projects_change_seq BEFORE INSERT OR UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION ps_bump_change_seq();
DROP TRIGGER IF EXISTS assets_change_seq ON assets;
CREATE TRIGGER assets_change_seq BEFORE INSERT OR UPDATE ON assets FOR EACH ROW EXECUTE FUNCTION ps_bump_change_seq();
DROP TRIGGER IF EXISTS brand_kits_change_seq ON brand_kits;
CREATE TRIGGER brand_kits_change_seq BEFORE INSERT OR UPDATE ON brand_kits FOR EACH ROW EXECUTE FUNCTION ps_bump_change_seq();
DROP TRIGGER IF EXISTS memberships_change_seq ON memberships;
CREATE TRIGGER memberships_change_seq BEFORE INSERT OR UPDATE ON memberships FOR EACH ROW EXECUTE FUNCTION ps_bump_change_seq();
DROP TRIGGER IF EXISTS workspaces_change_seq ON workspaces;
CREATE TRIGGER workspaces_change_seq BEFORE INSERT OR UPDATE ON workspaces FOR EACH ROW EXECUTE FUNCTION ps_bump_change_seq();
DROP TRIGGER IF EXISTS memberships_joined ON memberships;
CREATE TRIGGER memberships_joined AFTER INSERT ON memberships FOR EACH ROW EXECUTE FUNCTION ps_membership_joined();
DROP TRIGGER IF EXISTS projects_tombstone ON projects;
CREATE TRIGGER projects_tombstone AFTER DELETE ON projects FOR EACH ROW EXECUTE FUNCTION ps_tombstone('project');
DROP TRIGGER IF EXISTS assets_tombstone ON assets;
CREATE TRIGGER assets_tombstone AFTER DELETE ON assets FOR EACH ROW EXECUTE FUNCTION ps_tombstone('asset');

UPDATE projects SET change_seq = 0 WHERE change_seq IS NULL;
UPDATE assets SET change_seq = 0 WHERE change_seq IS NULL;
UPDATE brand_kits SET change_seq = 0 WHERE change_seq IS NULL;
UPDATE memberships SET change_seq = 0 WHERE change_seq IS NULL;
UPDATE workspaces SET change_seq = 0 WHERE change_seq IS NULL;
CREATE INDEX IF NOT EXISTS projects_seq_idx ON projects(workspace_id, change_seq);
CREATE INDEX IF NOT EXISTS assets_seq_idx ON assets(workspace_id, change_seq);
`

/**
 * v3 — bring-your-own-key AI providers: per-workspace AI settings (non-secret JSON) and encrypted provider keys
 * (AES-256-GCM, key from SECRETS_KEY). Deliberately no change_seq triggers: never part of the sync change feed.
 */
export const DDL_V3 = `
CREATE TABLE IF NOT EXISTS workspace_ai_settings (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  doc jsonb NOT NULL,
  updated_at double precision NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_keys (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL,
  ciphertext text NOT NULL,
  iv text NOT NULL,
  tag text NOT NULL,
  last4 text NOT NULL,
  updated_at double precision NOT NULL,
  PRIMARY KEY (workspace_id, provider)
);
`

/**
 * v4 — per-user appearance preferences (UserPreferences JSON). No change_seq trigger: not part of the sync feed.
 */
export const DDL_V4 = `
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  doc jsonb NOT NULL,
  updated_at double precision NOT NULL
);
`

/**
 * v5 — leaving a workspace (membership deleted, including by a workspace delete cascading) writes a tombstone
 * ('membership', user_id, workspace_id) so that user's desktop replicas drop the space (SyncChanges.deleted.workspaces).
 */
export const DDL_V5 = `
CREATE OR REPLACE FUNCTION ps_membership_left() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO tombstones (kind, id, workspace_id, change_seq, deleted_at)
  VALUES ('membership', OLD.user_id, OLD.workspace_id, nextval('change_seq'), extract(epoch from clock_timestamp()) * 1000);
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS memberships_left ON memberships;
CREATE TRIGGER memberships_left AFTER DELETE ON memberships FOR EACH ROW EXECUTE FUNCTION ps_membership_left();
CREATE INDEX IF NOT EXISTS tombstones_membership_idx ON tombstones(id, change_seq) WHERE kind = 'membership';
`

/**
 * v6 — VoiceStudio voice profiles (cloned / designed voices). The reference audio and the VoiceStudio-side profile live
 * only on the desktop that created it (`device_id`, `vs_profile_id` is local-only); the row itself syncs like a project
 * (change_seq + tombstones) so every replica can list and use the voice. Relay jobs (`voice.relay`) let the cloud ask that
 * desktop to generate speech.
 */
export const DDL_V6 = `
CREATE TABLE IF NOT EXISTS voice_profiles (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL,
  engine text NOT NULL,
  language text,
  gender text,
  description text,
  consent jsonb NOT NULL,
  device_id text,
  vs_profile_id text,
  sample_asset_id text,
  created_by text NOT NULL,
  created_at double precision NOT NULL,
  updated_at double precision NOT NULL,
  change_seq bigint
);
CREATE INDEX IF NOT EXISTS voice_profiles_ws_idx ON voice_profiles(workspace_id, change_seq);
DROP TRIGGER IF EXISTS voice_profiles_change_seq ON voice_profiles;
CREATE TRIGGER voice_profiles_change_seq BEFORE INSERT OR UPDATE ON voice_profiles FOR EACH ROW EXECUTE FUNCTION ps_bump_change_seq();
DROP TRIGGER IF EXISTS voice_profiles_tombstone ON voice_profiles;
CREATE TRIGGER voice_profiles_tombstone AFTER DELETE ON voice_profiles FOR EACH ROW EXECUTE FUNCTION ps_tombstone('voice_profile');

-- republish a workspace's voices to a member who joins it (ps_membership_joined covers projects/assets/brand)
CREATE OR REPLACE FUNCTION ps_membership_joined() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE projects SET change_seq = 0 WHERE workspace_id = NEW.workspace_id;
  UPDATE assets SET change_seq = 0 WHERE workspace_id = NEW.workspace_id;
  UPDATE brand_kits SET change_seq = 0 WHERE workspace_id = NEW.workspace_id;
  UPDATE voice_profiles SET change_seq = 0 WHERE workspace_id = NEW.workspace_id;
  RETURN NEW;
END $$;
`

/**
 * v7 — invites expire (7 days from creation; older rows count from created_at) and can be withdrawn by an owner.
 * An invite is accepted only by the account whose email it was sent to.
 */
export const DDL_V7 = `
ALTER TABLE invites ADD COLUMN IF NOT EXISTS expires_at double precision;
ALTER TABLE invites ADD COLUMN IF NOT EXISTS revoked_at double precision;
CREATE INDEX IF NOT EXISTS invites_ws_idx ON invites(workspace_id);
`

/**
 * v8 — a safe resume point for the change feed. change_seq is taken when a row is written, not when its transaction
 * commits, so a slow transaction can commit after newer changes were already read, behind a desktop's cursor. Every
 * change-writing transaction now registers where its changes start before taking its first number: a shared
 * transaction-level advisory lock keyed (CHANGE_LOCK_NS << 48) | <the sequence's value just before>, held until it ends.
 * The feed (routes/sync.ts) reads the sequence, then these locks, then the rows, and never lets `safe` pass the
 * lowest registered value. Shared locks never wait on each other, so writers don't block. Same on PGlite and Postgres.
 */
export const DDL_V8 = `
CREATE OR REPLACE FUNCTION ps_next_change_seq() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  low bigint;
BEGIN
  IF current_setting('ps.change_tx', true) IS DISTINCT FROM txid_current()::text THEN
    SELECT last_value INTO low FROM change_seq;
    PERFORM pg_advisory_xact_lock_shared((20563::bigint << 48) | low);
    PERFORM set_config('ps.change_tx', txid_current()::text, true);
  END IF;
  RETURN nextval('change_seq');
END $$;

CREATE OR REPLACE FUNCTION ps_bump_change_seq() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.change_seq := ps_next_change_seq();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION ps_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO tombstones (kind, id, workspace_id, change_seq, deleted_at)
  VALUES (TG_ARGV[0], OLD.id, OLD.workspace_id, ps_next_change_seq(), extract(epoch from clock_timestamp()) * 1000);
  RETURN OLD;
END $$;

CREATE OR REPLACE FUNCTION ps_membership_left() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO tombstones (kind, id, workspace_id, change_seq, deleted_at)
  VALUES ('membership', OLD.user_id, OLD.workspace_id, ps_next_change_seq(), extract(epoch from clock_timestamp()) * 1000);
  RETURN OLD;
END $$;
`

/**
 * v9 — voice profiles carry a server-stamped version (1 on create, +1 on every change the cloud accepts), so replicas
 * order edits by what the cloud saw, never by each computer's clock.
 */
export const DDL_V9 = `
ALTER TABLE voice_profiles ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
`

/**
 * v11 — collaboration. Share links get their own settings (expiry, password, download, comments) and a view count.
 * Timecoded review comments (threaded: a reply names its thread's first comment; share-page visitors comment with a
 * name and no account). A per-space activity feed. None of these sync to desktops: they live on the cloud.
 */
export const DDL_V11 = `
ALTER TABLE share_links ADD COLUMN IF NOT EXISTS expires_at double precision;
ALTER TABLE share_links ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE share_links ADD COLUMN IF NOT EXISTS allow_download boolean NOT NULL DEFAULT true;
ALTER TABLE share_links ADD COLUMN IF NOT EXISTS allow_comments boolean NOT NULL DEFAULT false;
ALTER TABLE share_links ADD COLUMN IF NOT EXISTS views integer NOT NULL DEFAULT 0;
ALTER TABLE share_links ADD COLUMN IF NOT EXISTS last_viewed_at double precision;
CREATE INDEX IF NOT EXISTS share_links_project_idx ON share_links(project_id);

CREATE TABLE IF NOT EXISTS comments (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  workspace_id text NOT NULL,
  parent_id text,
  author_id text,
  author_name text NOT NULL,
  share_token text,
  body text NOT NULL,
  at double precision,
  x double precision,
  y double precision,
  resolved_at double precision,
  resolved_by text,
  created_at double precision NOT NULL,
  updated_at double precision NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_project_idx ON comments(project_id, created_at);

CREATE TABLE IF NOT EXISTS activity (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  project_id text,
  actor_id text,
  actor_name text NOT NULL,
  kind text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at double precision NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_ws_idx ON activity(workspace_id, created_at, id);
`

/** Namespace (high 16 bits) of the advisory lock keys in DDL_V8: 'PS'. */
export const CHANGE_LOCK_NS = 20563

/** Ordered migrations after v1: [version, sql]. Append here; never edit a shipped entry. */
export const MIGRATIONS: Array<[number, string]> = [
  [2, DDL_V2],
  [3, DDL_V3],
  [4, DDL_V4],
  [5, DDL_V5],
  [6, DDL_V6],
  [7, DDL_V7],
  [8, DDL_V8],
  [9, DDL_V9],
  [11, DDL_V11],
]
