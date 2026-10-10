-- 0001: migration ledger and the shared reject-change trigger function.
--
-- Milestone 002, Increment 1. Applied by the migration runner
-- (src/lib/pg/migrate.ts) as shopaccess_owner, inside one transaction per file.
-- The runner owns the transaction: this file contains no BEGIN or COMMIT.
-- NEVER EXECUTED: written under Gate B-W.

CREATE TABLE shopaccess.schema_migrations (
  version    text PRIMARY KEY CHECK (version ~ '^[0-9]{4}_[a-z0-9_]{1,60}$'),
  checksum   text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL
);

-- Shared trigger function for immutable and append-only tables.
CREATE FUNCTION shopaccess.reject_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '% is not permitted on %', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;
REVOKE ALL ON FUNCTION shopaccess.reject_change() FROM PUBLIC;

-- The ledger is append-only: an applied migration is never rewritten or removed.
CREATE TRIGGER schema_migrations_append_only BEFORE UPDATE OR DELETE ON shopaccess.schema_migrations
  FOR EACH ROW EXECUTE FUNCTION shopaccess.reject_change();
CREATE TRIGGER schema_migrations_no_truncate BEFORE TRUNCATE ON shopaccess.schema_migrations
  FOR EACH STATEMENT EXECUTE FUNCTION shopaccess.reject_change();

-- No runtime or operator role has any privilege on the ledger.
