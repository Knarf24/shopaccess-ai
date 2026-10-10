-- Bootstrap for the ShopAccess PostgreSQL 17 foundation (Milestone 002, Increment 1).
--
-- NOT A NUMBERED MIGRATION. Run once per CLUSTER by a database administrator,
-- before migration 0001, in a database dedicated to ShopAccess. The migration
-- runner never reads this folder.
--
-- NEVER EXECUTED: written under Gate B-W. No statement in this file has been run.
--
-- FAIL CLOSED. Roles are cluster-wide. This file never adopts a role that
-- already exists: it cannot know who created such a role, what it may do or
-- what it is a member of. If any of the five ShopAccess roles, or either
-- schema, is already present, the first statement raises an error and nothing
-- is changed. The supported setup is a cluster that does not yet contain them.
--
-- The whole file is one transaction. After any error every later statement is
-- rejected until the final COMMIT, which then rolls back, so a client that
-- keeps going after an error (psql without ON_ERROR_STOP) still changes nothing.
--
-- This file creates roles WITHOUT login rights or credentials. Enabling login
-- for the migration, web and operator roles, and setting their credentials, is
-- done by the administrator outside the repository.

BEGIN;

-- 1. Preflight. Must stay the first statement after BEGIN: it runs before any
--    role, schema, privilege or credential is touched.
DO $bootstrap$
DECLARE
  v_existing text;
BEGIN
  SELECT pg_catalog.string_agg(r.rolname, ', ' ORDER BY r.rolname) INTO v_existing
    FROM pg_catalog.pg_roles r
   WHERE r.rolname IN ('shopaccess_owner', 'shopaccess_definer', 'shopaccess_web',
                       'shopaccess_worker', 'shopaccess_operator');
  IF v_existing IS NOT NULL THEN
    RAISE EXCEPTION 'ShopAccess bootstrap refused: role(s) already exist: %', v_existing
      USING ERRCODE = 'duplicate_object',
            HINT = 'Existing roles are never adopted. Use a cluster that does not contain them.';
  END IF;

  SELECT pg_catalog.string_agg(n.nspname, ', ' ORDER BY n.nspname) INTO v_existing
    FROM pg_catalog.pg_namespace n
   WHERE n.nspname IN ('shopaccess', 'shopaccess_api');
  IF v_existing IS NOT NULL THEN
    RAISE EXCEPTION 'ShopAccess bootstrap refused: schema(s) already exist: %', v_existing
      USING ERRCODE = 'duplicate_schema';
  END IF;
END
$bootstrap$;

-- 2. The five roles. Unconditional: if one appeared since the preflight, CREATE
--    ROLE fails and the transaction is rolled back.
-- Migration role: owns schemas, tables, triggers. Never used at runtime.
CREATE ROLE shopaccess_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
-- Owns the trusted entry-point functions. Can never log in.
CREATE ROLE shopaccess_definer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
-- Buyer-facing web process.
CREATE ROLE shopaccess_web NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
-- Payment worker. Receives NO grants in Increment 1.
CREATE ROLE shopaccess_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
-- Group for named operator logins.
CREATE ROLE shopaccess_operator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

-- The migration role may switch to the function owner so that it can hand the
-- entry-point functions over to it (migration 0006). It does not inherit the
-- function owner's privileges. No runtime role is a member of any role.
GRANT shopaccess_definer TO shopaccess_owner WITH INHERIT FALSE, SET TRUE;

-- Nothing is available to PUBLIC: not the database, not the default schema.
DO $bootstrap$
BEGIN
  EXECUTE pg_catalog.format('REVOKE ALL ON DATABASE %I FROM PUBLIC', pg_catalog.current_database());
  EXECUTE pg_catalog.format(
    'GRANT CONNECT ON DATABASE %I TO shopaccess_owner, shopaccess_web, shopaccess_operator',
    pg_catalog.current_database());
END
$bootstrap$;
-- CONNECT only. TEMPORARY is granted to nobody, so runtime roles cannot create
-- temporary objects. shopaccess_worker receives nothing at all in Increment 1.
REVOKE ALL ON SCHEMA public FROM PUBLIC;

-- Tables live in shopaccess; trusted entry-point functions live in shopaccess_api.
CREATE SCHEMA shopaccess AUTHORIZATION shopaccess_owner;
CREATE SCHEMA shopaccess_api AUTHORIZATION shopaccess_owner;
REVOKE ALL ON SCHEMA shopaccess FROM PUBLIC;
REVOKE ALL ON SCHEMA shopaccess_api FROM PUBLIC;

GRANT USAGE ON SCHEMA shopaccess TO shopaccess_definer, shopaccess_web, shopaccess_operator;
GRANT USAGE ON SCHEMA shopaccess_api TO shopaccess_definer, shopaccess_web, shopaccess_operator;
-- CREATE on shopaccess_api is granted to shopaccess_definer only for the moment
-- its functions are handed over, inside migration 0006, and revoked again there.

-- New objects carry no PUBLIC privileges, whichever of the two roles creates them.
ALTER DEFAULT PRIVILEGES FOR ROLE shopaccess_owner REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE shopaccess_owner REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE shopaccess_owner REVOKE ALL ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE shopaccess_definer REVOKE ALL ON FUNCTIONS FROM PUBLIC;

-- 3. Verification before COMMIT. The five roles must be exactly as designed:
--    no login, no elevated attribute, and one membership only. Anything else
--    raises an error and the whole bootstrap is rolled back.
DO $bootstrap$
DECLARE
  v_bad text;
BEGIN
  SELECT pg_catalog.string_agg(r.rolname, ', ' ORDER BY r.rolname) INTO v_bad
    FROM pg_catalog.pg_roles r
   WHERE r.rolname IN ('shopaccess_owner', 'shopaccess_definer', 'shopaccess_web',
                       'shopaccess_worker', 'shopaccess_operator')
     AND (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication
          OR r.rolbypassrls OR r.rolcanlogin OR r.rolinherit);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'ShopAccess bootstrap refused: role(s) not least-privilege: %', v_bad
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_roles r
       WHERE r.rolname IN ('shopaccess_owner', 'shopaccess_definer', 'shopaccess_web',
                           'shopaccess_worker', 'shopaccess_operator')) <> 5 THEN
    RAISE EXCEPTION 'ShopAccess bootstrap refused: the five roles are not all present'
      USING ERRCODE = 'undefined_object';
  END IF;

  SELECT pg_catalog.string_agg(m.rolname || ' in ' || g.rolname, ', ') INTO v_bad
    FROM pg_catalog.pg_auth_members a
    JOIN pg_catalog.pg_roles m ON m.oid = a.member
    JOIN pg_catalog.pg_roles g ON g.oid = a.roleid
   WHERE (m.rolname LIKE 'shopaccess\_%' OR g.rolname LIKE 'shopaccess\_%')
     AND NOT (m.rolname = 'shopaccess_owner' AND g.rolname = 'shopaccess_definer'
              AND NOT a.admin_option AND NOT a.inherit_option AND a.set_option);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'ShopAccess bootstrap refused: unexpected role membership: %', v_bad
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END
$bootstrap$;

COMMIT;
