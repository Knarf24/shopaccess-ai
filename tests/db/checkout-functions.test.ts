import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeKeyCheckValue } from "@/lib/pg/key-ring";
import { APPROVED_MIGRATIONS } from "@/lib/pg/migrate";
import { OPERATOR_STATEMENTS, SESSION_STATEMENTS } from "@/lib/pg/statements";
import { adminUrl, hex, INSUFFICIENT_PRIVILEGE, openDisposableDatabase, sqlState, TEST_NONCE_KEY, type DisposableDatabase } from "./harness";

// NEVER RUN. Written for the Increment 2.1 functions migration (0008); running it needs a separate authorization and
// a new disposable PostgreSQL 17 cluster (see ./harness). Nothing here is evidence until it has been run.
//
// Scope: the single-connection part of the function acceptance manifest (specification 19.15). The four entry points
// are called as the web role, through the fixed statements below. Fixtures and observations are direct statements of
// the test owner. Cases that need two connections at once are in checkout-concurrency.test.ts.
//
// PGT-112(c) is here. Its test-only trigger (policy P4, first exception) is three statements written inside
// withSuppressedInsert, which begins a transaction on one client, always rolls it back and never ends it any other
// way. The static test PGT-157 admits exactly those three statements in exactly that place and nothing wider.
//
// Statements: every statement this file sends is a fixed string, written where it is sent or held in the table SQL.
// Values travel only as bound parameters. The static test PGT-157 reads this file and depends on that.
//
// Privilege statements: the only ones are the four revocations of PGT-128, written inside withRevokedPrivilege, which
// begins a transaction, always rolls it back and never ends it any other way (policy P4, second exception).
//
// No other statement of this file creates, replaces, alters, drops or switches off anything.

const PRODUCT = "dmp_codebook15";
const VARIANT = "dmv_codebook15a";
const VARIANT_LIMIT_ONE = "dmv_codebook15b";
const MERCHANT = "dmm_shopaccessdemo";
const UNIT_AMOUNT = 79900;
const UNKNOWN_PRODUCT = "dmp_unknown01";
const UNKNOWN_VARIANT = "dmv_unknown01";
const ASSUMPTIONS = "SANDBOX_ZERO_TAX_SHIPPING_DISCOUNT_V1";

// Specification 15.2. The digests are the specification's; they are never changed to fit an implementation.
const SAQD_V1 = "cbb8289475d0e6784dae938e4038a5fd54dbb423d350adf3f4fbebf7b4cde944";
const SAQD_V2 = "1763b05d5e4118f0d7dfac99e0f57c61e80eddbe02f52166e1c79fbddfe4b39c";
const SAQD_V3 = "1eebb6d9507c3efdb5e094cad29230150dca6c834c7d20a5f8022d20be13d693";
// Proposed SADT-1 targets, computed outside a database. NOT PostgreSQL-verified. A mismatch is to be investigated and
// reported with what PostgreSQL returned; neither the target nor the helper is edited to make them agree.
const SADT_D1 = "69cf467b84e343c9678a70122b7d3dd50bd61117dfff28e08ac175300957c47e";
const SADT_D2 = "6bad0dfbbca9c34e18f8a72f28f22cdd9f4ed70a088cdfe4e4872b55f655b685";
const SADT_NOTE = "proposed SADT-1 target, not PostgreSQL-verified: investigate and report a mismatch, do not edit it away";

const ISOLATION_REFUSED = "0A000";
const IN_FAILED_TRANSACTION = "25P02";

/** Every statement of this file that is not written where it is sent. Each is a fixed string. */
const SQL = {
  begin: "BEGIN",
  commit: "COMMIT",
  rollback: "ROLLBACK",
  beginRepeatableRead: "BEGIN ISOLATION LEVEL REPEATABLE READ",
  beginSerializable: "BEGIN ISOLATION LEVEL SERIALIZABLE",
  beginReadUncommitted: "BEGIN ISOLATION LEVEL READ UNCOMMITTED",
  selectOne: "SELECT 1 AS one",

  // The four entry points, exactly as the reviewed catalogue has them (the static suite compares the two).
  startCheckout: "SELECT result, intent_id, quote_id, quote_expires_at FROM shopaccess_api.start_checkout($1, $2, $3, $4, $5, $6)",
  cancelCheckout: "SELECT result FROM shopaccess_api.cancel_checkout($1, $2, $3)",
  readCheckout:
    "SELECT result, owner_id, intent_id, purchase_group_id, stored_state, row_version, effective_status, replaces_intent_id, superseded_by_intent_id, intent_created_at, intent_updated_at, quote_id, merchant_id, merchant_display_name, product_id, product_title, variant_id, variant_label, quantity, unit_amount_cents, subtotal_cents, discount_cents, tax_cents, shipping_cents, total_cents, currency, assumptions_code, catalog_revision, quote_digest, quote_created_at, quote_expires_at, quote_stale, database_time, challenge_id, challenge_quote_digest, challenge_nonce_key_version, challenge_nonce_digest, challenge_summary, challenge_issued_at, challenge_expires_at, challenge_usable FROM shopaccess_api.read_checkout($1, $2, $3)",
  listOwnerCheckouts:
    "SELECT intent_id, purchase_group_id, stored_state, effective_status, intent_created_at, quote_expires_at FROM shopaccess_api.list_owner_checkouts($1, $2)",
  // The two confirmation entry points of migration 0009, exactly as the reviewed catalogue has them. Used only to
  // bring a checkout to USER_CONFIRMED through the real functions (PGT-137 and PGT-142, accepted-confirmation
  // variants); the tests of these two functions are in confirmation-functions.test.ts.
  issueChallengeCall:
    "SELECT result, challenge_id, quote_digest, nonce_key_version, nonce_digest, summary, expires_at FROM shopaccess_api.issue_challenge($1, $2, $3, $4, $5, $6)",
  consumeChallengeCall: "SELECT result, intent_id FROM shopaccess_api.consume_challenge($1, $2, $3, $4, $5, $6)",
  // The stored form of a nonce: the lowercase hex SHA-256 of its 43 characters, computed by the database.
  nonceDigestOf: "SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to($1, 'UTF8')), 'hex') AS digest",
  challengeRow: "SELECT status, checkout_intent_id, quote_id, owner_id, (consumed_at IS NOT NULL) AS consumed FROM shopaccess.confirmation_challenges WHERE id = $1",
  // A quantity sent as text, to show what PostgreSQL does with a value that cannot become an integer.
  startCheckoutTextQuantity: "SELECT result FROM shopaccess_api.start_checkout($1, $2, $3, $4, $5::text::integer, $6)",

  // Fixtures, written by the test owner. P6: the owner row first, then the intent row.
  lockOwner: "SELECT id FROM shopaccess.checkout_owners WHERE id = $1 FOR UPDATE",
  lockIntent: "SELECT id FROM shopaccess.checkout_intents WHERE id = $1 FOR UPDATE",
  insertOwner: "INSERT INTO shopaccess.checkout_owners (id, created_at) VALUES ($1, pg_catalog.clock_timestamp() + $2::interval)",
  insertSession:
    "INSERT INTO shopaccess.shopper_sessions (id, owner_id, key_version, token_digest, created_at, last_seen_at, absolute_expires_at) " +
    "SELECT $1, $2, 1, $3, t.now + $4::interval, t.now + $5::interval, t.now + $4::interval + interval '24 hours' " +
    "FROM (SELECT pg_catalog.clock_timestamp() AS now) t",
  revokeSessionDirectly: "UPDATE shopaccess.shopper_sessions SET revoked_at = pg_catalog.clock_timestamp(), row_version = row_version + 1 WHERE id = $1",
  insertGroup: "INSERT INTO shopaccess.purchase_groups (id, owner_id, created_at) VALUES ($1, $2, $3::timestamptz)",
  // The sixth value is the predecessor: NULL for the root of a group, the replaced intent for a replacement.
  insertIntent:
    "INSERT INTO shopaccess.checkout_intents (id, owner_id, purchase_group_id, replaces_intent_id, state, row_version, current_quote_id, created_at, updated_at) " +
    "VALUES ($1, $2, $3, $6, 'QUOTED', 2, $4, $5::timestamptz, $5::timestamptz)",
  cancelIntentDirectly: "UPDATE shopaccess.checkout_intents SET state = 'CANCELED_LOCAL', row_version = row_version + 1 WHERE id = $1",
  supersedeIntentDirectly: "UPDATE shopaccess.checkout_intents SET state = 'SUPERSEDED', superseded_by_intent_id = $2, row_version = row_version + 1 WHERE id = $1",
  rotateSessionDirectly:
    "UPDATE shopaccess.shopper_sessions SET token_digest = $2, last_seen_at = pg_catalog.clock_timestamp(), row_version = row_version + 1 WHERE id = $1",
  // The fixture's digest is computed with the helper start_checkout uses (specification 19.15, PGT-142 fixtures).
  insertQuote:
    "INSERT INTO shopaccess.quotes (id, owner_id, checkout_intent_id, merchant_id, catalog_revision, subtotal_cents, discount_cents, tax_cents, shipping_cents, total_cents, currency, assumptions_code, created_at, expires_at, digest, digest_version) " +
    "SELECT f.quote_id, f.owner_id, f.intent_id, 'dmm_shopaccessdemo', 1, 79900, 0, 0, 0, 79900, 'USD', 'SANDBOX_ZERO_TAX_SHIPPING_DISCOUNT_V1', f.created_at, f.created_at + interval '15 minutes', " +
    "shopaccess_api.quote_digest_saqd1(f.quote_id, f.owner_id, f.intent_id, f.group_id, 'dmm_shopaccessdemo', 'dmp_codebook15', 'dmv_codebook15a', 1::bigint, 1::bigint, 79900::bigint, 79900::bigint, 0::bigint, 0::bigint, 0::bigint, 79900::bigint, 'USD', 'SANDBOX_ZERO_TAX_SHIPPING_DISCOUNT_V1', f.created_at, f.created_at + interval '15 minutes'), 'SAQD-1' " +
    "FROM (SELECT $1::text AS quote_id, $2::text AS owner_id, $3::text AS intent_id, $4::text AS group_id, $5::timestamptz AS created_at) f",
  insertItem:
    "INSERT INTO shopaccess.quote_items (quote_id, line_number, product_id, variant_id, quantity, unit_amount_cents, line_subtotal_cents, merchant_display_name, product_title, variant_label, descriptive_terms_digest) " +
    "SELECT $1::text, 1, mv.product_id, mv.id, 1, 79900, 79900, mm.display_name, mp.title, mv.label, shopaccess_api.descriptive_terms_digest(mp.description, mv.specs) " +
    "FROM shopaccess.merchant_variants mv JOIN shopaccess.merchant_products mp ON mp.id = mv.product_id JOIN shopaccess.merchants mm ON mm.id = mp.merchant_id " +
    "WHERE mv.id = 'dmv_codebook15a'",
  insertTransition:
    "INSERT INTO shopaccess.checkout_transitions (checkout_intent_id, to_version, from_version, event_id, event_type, actor, entry_point, from_state, to_state, occurred_at, recorded_at) " +
    "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $10::timestamptz)",
  insertSyntheticAudit:
    "INSERT INTO shopaccess.audit_events (event_id, event_type, occurred_at, recorded_at, actor, session_id, owner_id, checkout_intent_id, operation_id, detail) " +
    "VALUES ('ev_' || replace(gen_random_uuid()::text, '-', ''), $1, $2::timestamptz, $2::timestamptz, $3, NULL, $4, $5, NULL, $6::jsonb)",
  insertChallenge:
    "INSERT INTO shopaccess.confirmation_challenges (id, owner_id, checkout_intent_id, quote_id, quote_digest, nonce_digest, nonce_key_version, summary, status, issued_at, expires_at) " +
    "SELECT $1::text, q.owner_id, q.checkout_intent_id, q.id, q.digest, $2::text, 1, '{}'::jsonb, 'ACTIVE', q.created_at + interval '1 minute', q.created_at + interval '6 minutes' " +
    "FROM shopaccess.quotes q WHERE q.id = $3",
  consumeChallenge: "UPDATE shopaccess.confirmation_challenges SET status = 'CONSUMED', consumed_at = issued_at + interval '1 minute' WHERE id = $1",
  confirmIntent:
    "UPDATE shopaccess.checkout_intents SET state = 'USER_CONFIRMED', confirmation_id = $2, confirmation_status = 'CONSUMED', updated_at = created_at + interval '2 minutes', row_version = row_version + 1 WHERE id = $1",
  insertWindow:
    "INSERT INTO shopaccess.owner_request_windows (owner_id, window_started_at, window_calls, window_throttled, total_throttled, updated_at) " +
    "SELECT $1, t.now + $2::interval, $3::integer, 0, 0, t.now + $4::interval FROM (SELECT pg_catalog.clock_timestamp() AS now) t",

  // Catalog changes by the test owner, for the staleness and catalog-refusal cases. Each is put back afterwards.
  setVariantAmount: "UPDATE shopaccess.merchant_variants SET unit_amount_cents = $2 WHERE id = $1",
  setVariantAvailability: "UPDATE shopaccess.merchant_variants SET availability = $2 WHERE id = $1",
  setVariantLimit: "UPDATE shopaccess.merchant_variants SET max_quantity_per_order = $2 WHERE id = $1",
  setVariantLabel: "UPDATE shopaccess.merchant_variants SET label = $2 WHERE id = $1",
  setVariantSpecs: "UPDATE shopaccess.merchant_variants SET specs = $2::jsonb WHERE id = $1",
  setVariantRevision: "UPDATE shopaccess.merchant_variants SET catalog_revision = $2 WHERE id = $1",
  setProductTitle: "UPDATE shopaccess.merchant_products SET title = $2 WHERE id = $1",
  setProductDescription: "UPDATE shopaccess.merchant_products SET description = $2 WHERE id = $1",
  setProductImage: "UPDATE shopaccess.merchant_products SET image_path = $2 WHERE id = $1",
  setProductRevision: "UPDATE shopaccess.merchant_products SET catalog_revision = $2 WHERE id = $1",
  setMerchantName: "UPDATE shopaccess.merchants SET display_name = $2 WHERE id = $1",
  variantCatalog:
    "SELECT mv.unit_amount_cents, mv.availability, mv.max_quantity_per_order, mv.label, mv.specs::text AS specs_text, mv.catalog_revision AS variant_revision, " +
    "mp.title, mp.description, mp.image_path, mp.catalog_revision AS product_revision, mm.display_name, pg_catalog.current_setting('server_encoding') AS server_encoding " +
    "FROM shopaccess.merchant_variants mv JOIN shopaccess.merchant_products mp ON mp.id = mv.product_id JOIN shopaccess.merchants mm ON mm.id = mp.merchant_id WHERE mv.id = $1",

  // PGT-103, PGT-104 and PGT-152: direct statements sent as the function owner (the test owner takes its role).
  setRoleDefiner: "SET ROLE shopaccess_definer",
  resetRole: "RESET ROLE",
  countMerchants: "SELECT count(*)::integer AS n FROM shopaccess.merchants",
  countProducts: "SELECT count(*)::integer AS n FROM shopaccess.merchant_products",
  countVariants: "SELECT count(*)::integer AS n FROM shopaccess.merchant_variants",
  lockMerchantForUpdate: "SELECT id FROM shopaccess.merchants WHERE id = $1 FOR UPDATE",
  lockProductForUpdate: "SELECT id FROM shopaccess.merchant_products WHERE id = $1 FOR UPDATE",
  lockVariantForUpdate: "SELECT id FROM shopaccess.merchant_variants WHERE id = $1 FOR UPDATE",
  lockVariantForShare: "SELECT id FROM shopaccess.merchant_variants WHERE id = $1 FOR SHARE",
  lockVariantForKeyShare: "SELECT id FROM shopaccess.merchant_variants WHERE id = $1 FOR KEY SHARE",
  touchMerchant: "UPDATE shopaccess.merchants SET display_name = display_name WHERE id = $1",
  touchProduct: "UPDATE shopaccess.merchant_products SET title = title WHERE id = $1",
  touchVariant: "UPDATE shopaccess.merchant_variants SET label = label WHERE id = $1",
  addMerchant: "INSERT INTO shopaccess.merchants (id, display_name) VALUES ($1, 'Another Merchant')",
  removeMerchant: "DELETE FROM shopaccess.merchants WHERE id = $1",
  removeProduct: "DELETE FROM shopaccess.merchant_products WHERE id = $1",
  removeVariant: "DELETE FROM shopaccess.merchant_variants WHERE id = $1",
  touchOwner: "UPDATE shopaccess.checkout_owners SET created_at = created_at WHERE id = $1",
  moveWindowOwner: "UPDATE shopaccess.owner_request_windows SET owner_id = $2 WHERE owner_id = $1",
  removeWindow: "DELETE FROM shopaccess.owner_request_windows WHERE owner_id = $1",
  removeIntent: "DELETE FROM shopaccess.checkout_intents WHERE id = $1",
  // PGT-13: the four statements that would change a quote or its item.
  touchQuote: "UPDATE shopaccess.quotes SET digest = digest WHERE id = $1",
  removeQuote: "DELETE FROM shopaccess.quotes WHERE id = $1",
  touchItem: "UPDATE shopaccess.quote_items SET quantity = quantity WHERE quote_id = $1",
  removeItem: "DELETE FROM shopaccess.quote_items WHERE quote_id = $1",

  // More fixtures and observations for the throttle, capacity and staleness cases.
  setProductMerchant: "UPDATE shopaccess.merchant_products SET merchant_id = $2 WHERE id = $1",
  // The window, moved 61 seconds into the past by the test owner: the owner's next call belongs to a new window.
  backdateWindow:
    "UPDATE shopaccess.owner_request_windows SET window_started_at = window_started_at - interval '61 seconds', updated_at = updated_at - interval '61 seconds' WHERE owner_id = $1",
  windowMargin:
    "SELECT (pg_catalog.clock_timestamp() >= w.window_started_at + interval '60 seconds') AS passed, " +
    "(extract(epoch FROM (w.window_started_at + interval '60 seconds' - pg_catalog.clock_timestamp())))::double precision AS remaining_seconds FROM shopaccess.owner_request_windows w WHERE w.owner_id = $1",
  quoteMargin:
    "SELECT (pg_catalog.clock_timestamp() >= q.expires_at) AS passed, " +
    "(extract(epoch FROM (q.expires_at - pg_catalog.clock_timestamp())))::double precision AS remaining_seconds FROM shopaccess.quotes q WHERE q.checkout_intent_id = $1",
  shortSleep: "SELECT pg_catalog.pg_sleep(0.005)",
  lockWaiters:
    "SELECT count(*)::integer AS n FROM pg_catalog.pg_stat_activity a " +
    "WHERE a.datname = pg_catalog.current_database() AND a.wait_event_type = 'Lock' AND a.pid <> pg_catalog.pg_backend_pid()",
  deleteSession: "DELETE FROM shopaccess.shopper_sessions WHERE id = $1",
  sessionByDigest: "SELECT id, owner_id FROM shopaccess.shopper_sessions WHERE token_digest = $1",
  ledgerRow: "SELECT version, checksum FROM shopaccess.schema_migrations WHERE version = $1",

  // Observations.
  intentRow:
    "SELECT state, row_version, owner_id, purchase_group_id, replaces_intent_id, superseded_by_intent_id, current_quote_id, confirmation_id, confirmation_status, created_by_session_id, " +
    "created_at, updated_at FROM shopaccess.checkout_intents WHERE id = $1",
  quoteRow:
    "SELECT q.id, q.owner_id, q.merchant_id, q.catalog_revision, q.subtotal_cents::integer AS subtotal_cents, q.discount_cents::integer AS discount_cents, q.tax_cents::integer AS tax_cents, " +
    "q.shipping_cents::integer AS shipping_cents, q.total_cents::integer AS total_cents, q.currency, q.assumptions_code, q.digest, q.digest_version, q.created_at, q.expires_at, " +
    "(q.expires_at = q.created_at + interval '15 minutes') AS lifetime_exact, md5(q::text) AS row_digest FROM shopaccess.quotes q WHERE q.checkout_intent_id = $1",
  itemRows:
    "SELECT line_number, product_id, variant_id, quantity, unit_amount_cents::integer AS unit_amount_cents, line_subtotal_cents::integer AS line_subtotal_cents, merchant_display_name, product_title, " +
    "variant_label, descriptive_terms_digest FROM shopaccess.quote_items WHERE quote_id = $1",
  transitionRows:
    "SELECT to_version, from_version, event_id, event_type, actor, entry_point, from_state, to_state, (occurred_at = recorded_at) AS times_equal " +
    "FROM shopaccess.checkout_transitions WHERE checkout_intent_id = $1 ORDER BY to_version",
  auditRows:
    "SELECT event_id, event_type, actor, session_id, owner_id, checkout_intent_id, operation_id, detail, (occurred_at = recorded_at) AS times_equal " +
    "FROM shopaccess.audit_events WHERE owner_id = $1 ORDER BY id",
  windowRow:
    "SELECT window_started_at, window_calls, window_throttled::integer AS window_throttled, total_throttled::integer AS total_throttled, updated_at, " +
    "(updated_at >= window_started_at) AS ordered FROM shopaccess.owner_request_windows WHERE owner_id = $1",
  sessionRow: "SELECT last_seen_at, row_version, revoked_at FROM shopaccess.shopper_sessions WHERE id = $1",
  ownerCounts:
    "SELECT (SELECT count(*)::integer FROM shopaccess.purchase_groups g WHERE g.owner_id = $1) AS groups, " +
    "(SELECT count(*)::integer FROM shopaccess.checkout_intents i WHERE i.owner_id = $1) AS intents, " +
    "(SELECT count(*)::integer FROM shopaccess.quotes q WHERE q.owner_id = $1) AS quotes, " +
    "(SELECT count(*)::integer FROM shopaccess.audit_events a WHERE a.owner_id = $1) AS audits",
  // Row count and content of the seven tables and the audit table, in one statement and so one snapshot.
  snapshot:
    "SELECT (SELECT count(*)::text || ':' || coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') FROM shopaccess.purchase_groups t) AS purchase_groups, " +
    "(SELECT count(*)::text || ':' || coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') FROM shopaccess.checkout_intents t) AS checkout_intents, " +
    "(SELECT count(*)::text || ':' || coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') FROM shopaccess.quotes t) AS quotes, " +
    "(SELECT count(*)::text || ':' || coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') FROM shopaccess.quote_items t) AS quote_items, " +
    "(SELECT count(*)::text || ':' || coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') FROM shopaccess.confirmation_challenges t) AS confirmation_challenges, " +
    "(SELECT count(*)::text || ':' || coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') FROM shopaccess.checkout_transitions t) AS checkout_transitions, " +
    "(SELECT count(*)::text || ':' || coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') FROM shopaccess.owner_request_windows t) AS owner_request_windows, " +
    "(SELECT count(*)::text || ':' || coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') FROM shopaccess.audit_events t) AS audit_events, " +
    "(SELECT count(*)::text || ':' || coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') FROM shopaccess.shopper_sessions t) AS shopper_sessions",

  // The internal helpers, called by the test owner as the administrator of this disposable database.
  saqd:
    "SELECT shopaccess_api.quote_digest_saqd1($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::bigint, $9::bigint, $10::bigint, $11::bigint, $12::bigint, $13::bigint, $14::bigint, " +
    "$15::bigint, $16::text, $17::text, pg_catalog.to_timestamp($18::double precision / 1000000), pg_catalog.to_timestamp($19::double precision / 1000000)) AS digest",
  saqdOfStoredQuote:
    "SELECT q.digest AS stored, shopaccess_api.quote_digest_saqd1(q.id, q.owner_id, q.checkout_intent_id, i.purchase_group_id, q.merchant_id, qi.product_id, qi.variant_id, q.catalog_revision::bigint, " +
    "qi.quantity::bigint, qi.unit_amount_cents, q.subtotal_cents, q.discount_cents, q.tax_cents, q.shipping_cents, q.total_cents, q.currency, q.assumptions_code, q.created_at, q.expires_at) AS computed " +
    "FROM shopaccess.quotes q JOIN shopaccess.checkout_intents i ON i.id = q.checkout_intent_id JOIN shopaccess.quote_items qi ON qi.quote_id = q.id WHERE q.checkout_intent_id = $1",
  sadt: "SELECT shopaccess_api.descriptive_terms_digest($1::text, $2::jsonb) AS digest, ($2::jsonb)::text AS specs_text",
  sadtOfVariant:
    "SELECT shopaccess_api.descriptive_terms_digest(mp.description, mv.specs) AS digest, mv.specs::text AS specs_text, mp.description " +
    "FROM shopaccess.merchant_variants mv JOIN shopaccess.merchant_products mp ON mp.id = mv.product_id WHERE mv.id = $1",
  materialChange:
    "SELECT shopaccess_api.quote_material_change($1::bigint, $2::text, $3::integer, $4::text, $5::text, $6::text, $7::text, $8::text, " +
    "shopaccess_api.descriptive_terms_digest($9::text, $10::jsonb), $11::bigint, $12::text, $13::text, $14::integer, $15::text, $16::text, $17::text, $18::text, $19::text, $20::text, $21::jsonb) AS stale",
  windowDecision:
    "SELECT d.starts_new_window, d.over_limit FROM shopaccess_api.owner_window_decision($1::timestamptz, $2::integer, $1::timestamptz + $3::interval) d",
  windowDecisionNoRow: "SELECT d.starts_new_window, d.over_limit FROM shopaccess_api.owner_window_decision(NULL::timestamptz, NULL::integer, pg_catalog.clock_timestamp()) d",
  transition:
    "SELECT x.accepted, x.to_state, x.to_version, x.quote_id, x.confirmation_id, x.superseded_by_intent_id " +
    "FROM shopaccess_api.checkout_transition($1::text, $2::integer, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text, $9::text, $10::text, $11::text) x",
  guardAsWeb: "SELECT shopaccess_api.require_read_committed(1) AS value",
  setTimeZoneKolkata: "SET TIME ZONE 'Asia/Kolkata'",
  setDateStyleGerman: "SET DateStyle TO 'German, DMY'",
  resetTimeZone: "RESET TIME ZONE",
  resetDateStyle: "RESET DateStyle",

  // Inventory and privileges of the functions migration.
  apiFunctions:
    "SELECT p.oid::regprocedure::text AS signature, p.proname::text AS name, r.rolname::text AS owner, p.prosecdef AS security_definer, p.provolatile::text AS volatility, l.lanname::text AS language, " +
    "p.proconfig AS config, " +
    "pg_catalog.has_function_privilege('shopaccess_web', p.oid, 'EXECUTE') AS web, " +
    "pg_catalog.has_function_privilege('shopaccess_operator', p.oid, 'EXECUTE') AS operator, " +
    "pg_catalog.has_function_privilege('shopaccess_worker', p.oid, 'EXECUTE') AS worker, " +
    "pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS everyone " +
    "FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace JOIN pg_catalog.pg_roles r ON r.oid = p.proowner JOIN pg_catalog.pg_language l ON l.oid = p.prolang " +
    "WHERE n.nspname = 'shopaccess_api' ORDER BY p.proname",
  definerTableGrants:
    "SELECT table_name::text || ':' || privilege_type::text AS held FROM information_schema.role_table_grants " +
    "WHERE grantee = 'shopaccess_definer' AND table_schema = 'shopaccess' ORDER BY 1",
  definerColumnGrants:
    "SELECT table_name::text || '.' || column_name::text || ':' || privilege_type::text AS held FROM information_schema.role_column_grants " +
    "WHERE grantee = 'shopaccess_definer' AND table_schema = 'shopaccess' AND table_name = 'owner_request_windows' AND privilege_type = 'UPDATE' ORDER BY 1",
  runtimeTableGrants:
    "SELECT grantee::text || ':' || table_name::text || ':' || privilege_type::text AS held FROM information_schema.role_table_grants " +
    "WHERE grantee IN ('shopaccess_web', 'shopaccess_operator', 'shopaccess_worker', 'PUBLIC') AND table_schema = 'shopaccess' " +
    "AND table_name IN ('purchase_groups', 'checkout_intents', 'quotes', 'quote_items', 'confirmation_challenges', 'checkout_transitions', 'owner_request_windows') ORDER BY 1",
  ledgerOf: "SELECT version FROM shopaccess.schema_migrations WHERE version = $1",
  // PGT-112(c): what is left of the test-only trigger and its function. Nothing, outside the rolled-back transaction.
  suppressionFixtures:
    "SELECT (SELECT count(*)::integer FROM pg_catalog.pg_trigger t WHERE t.tgname IN ('pgt112_suppress_quote_item', 'pgt112_suppress_transition')) AS triggers, " +
    "(SELECT count(*)::integer FROM pg_catalog.pg_proc p WHERE p.proname = 'pgt112_suppress_row') AS functions",
  definerPrivileges:
    "SELECT pg_catalog.has_table_privilege('shopaccess_definer', 'shopaccess.owner_request_windows', 'INSERT') AS window_insert, " +
    "pg_catalog.has_column_privilege('shopaccess_definer', 'shopaccess.owner_request_windows', 'window_calls', 'UPDATE') AS window_calls_update, " +
    "pg_catalog.has_column_privilege('shopaccess_definer', 'shopaccess.owner_request_windows', 'total_throttled', 'UPDATE') AS total_throttled_update, " +
    "pg_catalog.has_table_privilege('shopaccess_definer', 'shopaccess.audit_events', 'INSERT') AS audit_insert",
} as const;
type CallKey = "startCheckout" | "cancelCheckout" | "readCheckout" | "listOwnerCheckouts";
type IsolationKey = "beginRepeatableRead" | "beginSerializable" | "beginReadUncommitted";

type Admin = DisposableDatabase["admin"];
type Web = DisposableDatabase["web"];

/** A session of one owner, as the functions see it: the credential is key version 1 and this token digest. */
interface Credential {
  readonly owner: string;
  readonly session: string;
  readonly digest: string;
}

const KEY_VERSION = 1;
const newId = (prefix: string): string => `${prefix}_${hex(16)}`;
const NOW = "0 seconds";

/**
 * A session row written by the test owner, for a new owner or an existing one. `createdOffset` and `lastSeenOffset`
 * are PostgreSQL interval texts relative to the database clock; the absolute expiry is 24 hours after creation.
 */
async function newCredential(client: Admin, createdOffset: string = NOW, lastSeenOffset: string = NOW, existingOwner: string | null = null): Promise<Credential> {
  const owner = existingOwner ?? newId("own");
  const session = newId("ses");
  const digest = hex(32);
  if (existingOwner === null) await client.query(SQL.insertOwner, [owner, createdOffset]);
  await client.query(SQL.insertSession, [session, owner, digest, createdOffset, lastSeenOffset]);
  return { owner, session, digest };
}

async function startCheckout(
  pool: Web,
  credential: Credential,
  productId: string = PRODUCT,
  variantId: string = VARIANT,
  quantity: number = 1,
  replaces: string | null = null,
): Promise<{ result: string; intent_id: string | null; quote_id: string | null; quote_expires_at: Date | null }> {
  const { rows } = await pool.query(SQL.startCheckout, [KEY_VERSION, credential.digest, productId, variantId, quantity, replaces]);
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function cancelCheckout(pool: Web, credential: Credential, intent: string): Promise<string> {
  const { rows } = await pool.query(SQL.cancelCheckout, [KEY_VERSION, credential.digest, intent]);
  expect(rows).toHaveLength(1);
  return rows[0].result;
}

async function readCheckout(pool: Web, credential: Credential, intent: string | null) {
  const { rows } = await pool.query(SQL.readCheckout, [KEY_VERSION, credential.digest, intent]);
  // Always exactly one row, whatever the outcome.
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function listCheckouts(pool: Web, credential: Credential) {
  return (await pool.query(SQL.listOwnerCheckouts, [KEY_VERSION, credential.digest])).rows;
}

async function snapshotOf(client: Admin) {
  return (await client.query(SQL.snapshot)).rows[0];
}

async function windowOf(client: Admin, owner: string) {
  const { rows } = await client.query(SQL.windowRow, [owner]);
  return rows.length === 0 ? null : rows[0];
}

async function intentOf(client: Admin, intent: string) {
  return (await client.query(SQL.intentRow, [intent])).rows[0];
}

async function auditOf(client: Admin, owner: string) {
  return (await client.query(SQL.auditRows, [owner])).rows;
}

async function countsOf(client: Admin, owner: string): Promise<{ groups: number; intents: number; quotes: number; audits: number }> {
  return (await client.query(SQL.ownerCounts, [owner])).rows[0];
}

/** An admitted call that writes nothing but the counter: a well-formed request for a product that does not exist. */
async function admittedCall(pool: Web, credential: Credential): Promise<string> {
  return (await startCheckout(pool, credential, UNKNOWN_PRODUCT, UNKNOWN_VARIANT)).result;
}

interface FixtureCheckout {
  readonly intent: string;
  readonly quote: string;
  readonly group: string;
  readonly challenge: string | null;
}

/**
 * A checkout written directly by the test owner in one transaction, with every time relative to `createdAt`: the
 * purchase group, the intent, its quote (digest from the helper start_checkout uses), its item, the first transition
 * and a synthetic QUOTE_ISSUED audit row. With `confirmed`, the same transaction also writes a consumed challenge,
 * moves the intent to USER_CONFIRMED at version 3, writes the confirming transition and a synthetic
 * CONFIRMATION_ACCEPTED audit row (specification 19.15, PGT-142 fixtures). Nothing is switched off: every constraint
 * and trigger applies, and the deferred checks are decided at COMMIT.
 */
async function insertFixtureCheckout(client: Admin, credential: Credential, createdAt: Date, confirmed: boolean): Promise<FixtureCheckout> {
  const intent = newId("ci");
  const quote = newId("qt");
  const group = newId("pur");
  const challenge = confirmed ? newId("cf") : null;
  const created = createdAt.toISOString();
  const confirmedAt = new Date(createdAt.getTime() + 2 * 60 * 1000).toISOString();
  const quoteEvent = newId("ev");
  const confirmEvent = newId("ev");
  await client.query(SQL.begin);
  try {
    await client.query(SQL.insertGroup, [group, credential.owner, created]);
    await client.query(SQL.insertIntent, [intent, credential.owner, group, quote, created, null]);
    await client.query(SQL.insertQuote, [quote, credential.owner, intent, group, created]);
    await client.query(SQL.insertItem, [quote]);
    await client.query(SQL.insertTransition, [intent, 2, 1, quoteEvent, "QUOTE_ISSUED", "server", "start_checkout", "DRAFT", "QUOTED", created]);
    await client.query(SQL.insertSyntheticAudit, ["QUOTE_ISSUED", created, "server", credential.owner, intent, JSON.stringify({ transitionEventId: quoteEvent, quoteId: quote })]);
    if (challenge !== null) {
      await client.query(SQL.lockOwner, [credential.owner]);
      await client.query(SQL.lockIntent, [intent]);
      await client.query(SQL.insertChallenge, [challenge, hex(32), quote]);
      await client.query(SQL.consumeChallenge, [challenge]);
      await client.query(SQL.confirmIntent, [intent, challenge]);
      await client.query(SQL.insertTransition, [intent, 3, 2, confirmEvent, "SHOPPER_CONFIRMED", "shopper", "consume_challenge", "QUOTED", "USER_CONFIRMED", confirmedAt]);
      await client.query(SQL.insertSyntheticAudit, [
        "CONFIRMATION_ACCEPTED",
        confirmedAt,
        "shopper",
        credential.owner,
        intent,
        JSON.stringify({ transitionEventId: confirmEvent, challengeId: challenge, quoteId: quote }),
      ]);
    }
    await client.query(SQL.commit);
  } catch (error) {
    await client.query(SQL.rollback);
    throw error;
  }
  return { intent, quote, group, challenge };
}

/**
 * Moves a QUOTED fixture checkout to CANCELED_LOCAL by direct writes of the test owner, in one transaction, under
 * the locks of P6: the intent's change and its cancelling transition. No function runs, so no request-window row and
 * no audit row is written.
 */
async function cancelFixtureDirectly(client: Admin, credential: Credential, fixture: FixtureCheckout): Promise<void> {
  await client.query(SQL.begin);
  try {
    await client.query(SQL.lockOwner, [credential.owner]);
    await client.query(SQL.lockIntent, [fixture.intent]);
    await client.query(SQL.cancelIntentDirectly, [fixture.intent]);
    await client.query(SQL.insertTransition, [fixture.intent, 3, 2, newId("ev"), "SHOPPER_CANCELED", "shopper", "cancel_checkout", "QUOTED", "CANCELED_LOCAL", new Date().toISOString()]);
    await client.query(SQL.commit);
  } catch (error) {
    await client.query(SQL.rollback);
    throw error;
  }
}

/**
 * One purchase group holding a chain of `length` intents, written directly by the test owner in one transaction:
 * each intent but the first replaces the one before it, which is marked SUPERSEDED with its pointer and its
 * transition, in the write order of specification 19.3. Returns the last intent, the only one still QUOTED.
 */
async function insertFixtureChain(
  client: Admin,
  credential: Credential,
  length: number,
  createdAt: Date = new Date(Date.now() - 60 * 1000),
): Promise<{ group: string; last: string; intents: string[] }> {
  const group = newId("pur");
  const created = createdAt.toISOString();
  const intents: string[] = [];
  let previous: string | null = null;
  await client.query(SQL.begin);
  try {
    await client.query(SQL.lockOwner, [credential.owner]);
    await client.query(SQL.insertGroup, [group, credential.owner, created]);
    for (let index = 0; index < length; index += 1) {
      const intent = newId("ci");
      const quote = newId("qt");
      await client.query(SQL.insertIntent, [intent, credential.owner, group, quote, created, previous]);
      await client.query(SQL.insertQuote, [quote, credential.owner, intent, group, created]);
      await client.query(SQL.insertItem, [quote]);
      await client.query(SQL.insertTransition, [intent, 2, 1, newId("ev"), "QUOTE_ISSUED", "server", "start_checkout", "DRAFT", "QUOTED", created]);
      if (previous !== null) {
        await client.query(SQL.lockIntent, [previous]);
        await client.query(SQL.supersedeIntentDirectly, [previous, intent]);
        await client.query(SQL.insertTransition, [previous, 3, 2, newId("ev"), "SUPERSEDED", "server", "start_checkout", "QUOTED", "SUPERSEDED", created]);
      }
      intents.push(intent);
      previous = intent;
    }
    await client.query(SQL.commit);
  } catch (error) {
    await client.query(SQL.rollback);
    throw error;
  }
  return { group, last: previous ?? "", intents };
}

function sqlStateOf(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "UNKNOWN";
}

type FunctionOwnerKey =
  | "countMerchants"
  | "countProducts"
  | "countVariants"
  | "lockMerchantForUpdate"
  | "lockProductForUpdate"
  | "lockVariantForUpdate"
  | "lockVariantForShare"
  | "lockVariantForKeyShare"
  | "touchMerchant"
  | "touchProduct"
  | "touchVariant"
  | "addMerchant"
  | "removeMerchant"
  | "removeProduct"
  | "removeVariant"
  | "moveWindowOwner"
  | "removeWindow"
  | "removeIntent"
  | "touchQuote"
  | "removeQuote"
  | "touchItem"
  | "removeItem";

/**
 * Sends one direct statement as the function owner: the test owner takes the role shopaccess_definer, sends the
 * statement, and gives the role up again in every case. Reports the SQLSTATE the statement met, or null.
 */
async function asFunctionOwner(client: Admin, statement: FunctionOwnerKey, values: readonly unknown[]): Promise<string | null> {
  await client.query(SQL.setRoleDefiner);
  try {
    await client.query(SQL[statement], [...values]);
    return null;
  } catch (error) {
    return sqlStateOf(error);
  } finally {
    await client.query(SQL.resetRole);
  }
}

type ImmutableKey = "touchQuote" | "removeQuote" | "touchItem" | "removeItem";

/**
 * PGT-13, as the test owner, in one transaction that is rolled back, under the locks of P6: one statement that would
 * change a quote or its item. Reports the SQLSTATE and the message it met, or nulls if it was not refused.
 */
async function immutableRowAttempt(client: Admin, owner: string, intent: string, statement: ImmutableKey, quote: string): Promise<{ sqlstate: string | null; message: string | null }> {
  await client.query(SQL.begin);
  try {
    await client.query(SQL.lockOwner, [owner]);
    await client.query(SQL.lockIntent, [intent]);
    try {
      await client.query(SQL[statement], [quote]);
      return { sqlstate: null, message: null };
    } catch (error) {
      return { sqlstate: sqlStateOf(error), message: error instanceof Error ? error.message : null };
    }
  } finally {
    await client.query(SQL.rollback);
  }
}

/**
 * PGT-104, as the function owner, in one transaction that is rolled back: the locking read of an owner row, then an
 * UPDATE of that row. Reports how many rows the lock returned and what the UPDATE met.
 */
async function ownerRowAsFunctionOwner(client: Admin, owner: string): Promise<{ locked: number | null; update: string | null; message: string | null }> {
  await client.query(SQL.begin);
  try {
    await client.query(SQL.setRoleDefiner);
    const locked = (await client.query(SQL.lockOwner, [owner])).rowCount;
    let update: string | null = null;
    let message: string | null = null;
    try {
      await client.query(SQL.touchOwner, [owner]);
    } catch (error) {
      update = sqlStateOf(error);
      message = error instanceof Error ? error.message : null;
    }
    return { locked, update, message };
  } finally {
    await client.query(SQL.rollback);
    await client.query(SQL.resetRole);
  }
}

/**
 * What a call does at an isolation level other than READ COMMITTED: the SQLSTATE it raises, or null when it returns.
 * The transaction is always rolled back.
 */
async function refusedAtIsolation(client: Admin, level: IsolationKey, statement: CallKey, values: readonly unknown[]): Promise<string | null> {
  await client.query(SQL[level]);
  try {
    return await sqlState(() => client.query(SQL[statement], [...values]));
  } finally {
    await client.query(SQL.rollback);
  }
}

type SuppressedTable = "quote_items" | "checkout_transitions";

interface SuppressedOutcome {
  /** The result code the call returned, or null when the call raised. A returned result fails PGT-112(c). */
  readonly returned: string | null;
  readonly sqlstate: string | null;
  readonly constraint: string | null;
  readonly message: string | null;
  /** What the next statement in the same transaction met: the SQLSTATE of an aborted transaction after a call that raised. */
  readonly afterwards: string | null;
  /** How many of the test-only objects existed inside the transaction, before the call. */
  readonly fixturesInside: { triggers: number; functions: number };
}

/**
 * PGT-112(c) (policy P4, first exception). On one client: begins a transaction; creates the test-only trigger
 * function, which returns NULL, and one BEFORE INSERT row trigger using it, on the given table; calls the function;
 * and always rolls back. Nothing here ends the transaction any other way, so the trigger and its function never
 * exist outside it. The trigger suppresses the child row the function inserts. That row's own deferred check never
 * fires for it; the deferred check queued by the parent row does, when the function forces the constraints, and it
 * must fail inside the call. Reports whether the call returned or raised, and with what.
 */
async function withSuppressedInsert(
  client: Admin,
  suppressed: SuppressedTable,
  statement: "startCheckout" | "cancelCheckout",
  values: readonly unknown[],
): Promise<SuppressedOutcome> {
  await client.query(SQL.begin);
  try {
    await client.query("CREATE FUNCTION shopaccess.pgt112_suppress_row() RETURNS trigger LANGUAGE plpgsql AS $pgt112$ BEGIN RETURN NULL; END; $pgt112$");
    if (suppressed === "quote_items") {
      await client.query("CREATE TRIGGER pgt112_suppress_quote_item BEFORE INSERT ON shopaccess.quote_items FOR EACH ROW EXECUTE FUNCTION shopaccess.pgt112_suppress_row()");
    }
    if (suppressed === "checkout_transitions") {
      await client.query("CREATE TRIGGER pgt112_suppress_transition BEFORE INSERT ON shopaccess.checkout_transitions FOR EACH ROW EXECUTE FUNCTION shopaccess.pgt112_suppress_row()");
    }
    const fixturesInside = (await client.query(SQL.suppressionFixtures)).rows[0];
    let returned: string | null = null;
    let failure: unknown = null;
    try {
      const reply = statement === "startCheckout" ? await client.query(SQL.startCheckout, [...values]) : await client.query(SQL.cancelCheckout, [...values]);
      returned = String(reply.rows[0].result);
    } catch (error) {
      failure = error;
    }
    const afterwards = await sqlState(() => client.query(SQL.selectOne));
    const fields = (typeof failure === "object" && failure !== null ? failure : {}) as { code?: unknown; constraint?: unknown; message?: unknown };
    return {
      returned,
      sqlstate: typeof fields.code === "string" ? fields.code : null,
      constraint: typeof fields.constraint === "string" ? fields.constraint : null,
      message: typeof fields.message === "string" ? fields.message : null,
      afterwards,
      fixturesInside,
    };
  } finally {
    await client.query(SQL.rollback);
  }
}

type Revocation = "K1" | "K2" | "K3" | "A";

/**
 * PGT-128 (policy P4, second exception). Begins a transaction, sends exactly one of the four permitted revocations,
 * calls the function, and always rolls back; nothing here ends the transaction any other way. Reports the SQLSTATE
 * the call raised (null when it did not raise) and what the next statement in the same transaction met: a call that
 * failed has aborted the transaction, so that statement is refused too.
 */
async function withRevokedPrivilege(
  client: Admin,
  revocation: Revocation,
  statement: "startCheckout" | "cancelCheckout",
  values: readonly unknown[],
): Promise<{ raised: string | null; afterwards: string | null }> {
  await client.query(SQL.begin);
  try {
    if (revocation === "K1") await client.query("REVOKE INSERT ON shopaccess.owner_request_windows FROM shopaccess_definer");
    if (revocation === "K2") await client.query("REVOKE UPDATE (window_calls) ON shopaccess.owner_request_windows FROM shopaccess_definer");
    if (revocation === "K3") await client.query("REVOKE UPDATE (total_throttled) ON shopaccess.owner_request_windows FROM shopaccess_definer");
    if (revocation === "A") await client.query("REVOKE INSERT ON shopaccess.audit_events FROM shopaccess_definer");
    const raised =
      statement === "startCheckout"
        ? await sqlState(() => client.query(SQL.startCheckout, [...values]))
        : await sqlState(() => client.query(SQL.cancelCheckout, [...values]));
    const afterwards = await sqlState(() => client.query(SQL.selectOne));
    return { raised, afterwards };
  } finally {
    await client.query(SQL.rollback);
  }
}

const minutesAgo = (minutes: number): Date => new Date(Date.now() - minutes * 60 * 1000);
const sortedKeys = (value: Record<string, unknown>): string[] => Object.keys(value).sort();

describe.skipIf(!adminUrl())("Increment 2.1 checkout functions (migration 0008) on a disposable PostgreSQL 17 database", () => {
  let db: DisposableDatabase;

  beforeAll(async () => {
    db = await openDisposableDatabase();
    // A session row can be inserted only under an ACTIVE session key, and a challenge only under an ACTIVE nonce
    // key. The check values are test values; no key material is stored.
    const session = await db.operator.query(OPERATOR_STATEMENTS.activateKeyVersion, ["session", 1, computeKeyCheckValue(TEST_NONCE_KEY, "session")]);
    expect(session.rows[0].result).toBe("ACTIVATED");
    const nonce = await db.operator.query(OPERATOR_STATEMENTS.activateKeyVersion, ["confirmation_nonce", 1, computeKeyCheckValue(TEST_NONCE_KEY, "confirmation_nonce")]);
    expect(nonce.rows[0].result).toBe("ACTIVATED");
  });
  afterAll(async () => {
    await db?.destroy();
  });

  it("PGT-101 and PGT-102 (functions part): the twelve functions of migrations 0008 and 0009 exist with their owner, mode and grants, and the function owner holds exactly the table privileges of 19.13", async () => {
    expect((await db.admin.query(SQL.ledgerOf, ["0008_checkout_functions"])).rows).toEqual([{ version: "0008_checkout_functions" }]);
    // The ledger row carries the checksum the runner's inventory pins for the functions file.
    const pinned = APPROVED_MIGRATIONS.find((entry) => entry.version === "0008_checkout_functions");
    expect(pinned).toBeDefined();
    expect((await db.admin.query(SQL.ledgerRow, ["0008_checkout_functions"])).rows).toEqual([{ version: "0008_checkout_functions", checksum: pinned?.sha256 }]);

    const { rows } = await db.admin.query(SQL.apiFunctions);
    // The four entry points of migration 0008 and the two of migration 0009. read_checkout is the 41-column function
    // of 0009, in the place of the one of 0008.
    const entryPoints = ["cancel_checkout", "consume_challenge", "issue_challenge", "list_owner_checkouts", "read_checkout", "start_checkout"];
    const helpers = ["checkout_transition", "descriptive_terms_digest", "owner_window_decision", "quote_digest_saqd1", "quote_material_change", "require_read_committed"];
    const increment1 = ["activate_key_version", "admit_session", "authorize_session", "revoke_key_version", "revoke_session", "rotate_session", "session_is_live"];
    expect(rows.map((row) => row.name)).toEqual([...entryPoints, ...helpers, ...increment1].sort());

    for (const row of rows) {
      expect(row.owner, row.name).toBe("shopaccess_definer");
      expect(row.config, row.name).toEqual(["search_path=pg_catalog, pg_temp"]);
      expect(row.everyone, row.name).toBe(false);
      expect(row.worker, row.name).toBe(false);
      if (entryPoints.includes(row.name)) {
        expect(row.security_definer, row.name).toBe(true);
        expect(row.web, row.name).toBe(true);
        expect(row.operator, row.name).toBe(false);
      }
      if (helpers.includes(row.name)) {
        // Invoker rights, and executable by no runtime role.
        expect(row.security_definer, row.name).toBe(false);
        expect(row.web, row.name).toBe(false);
        expect(row.operator, row.name).toBe(false);
      }
    }
    const byName = new Map<string, { volatility: string; language: string }>(rows.map((row) => [row.name, { volatility: row.volatility, language: row.language }]));
    expect(byName.get("read_checkout")).toEqual({ volatility: "s", language: "sql" });
    expect(byName.get("list_owner_checkouts")).toEqual({ volatility: "s", language: "sql" });
    expect(byName.get("start_checkout")).toEqual({ volatility: "v", language: "plpgsql" });
    expect(byName.get("cancel_checkout")).toEqual({ volatility: "v", language: "plpgsql" });
    expect(byName.get("issue_challenge")).toEqual({ volatility: "v", language: "plpgsql" });
    expect(byName.get("consume_challenge")).toEqual({ volatility: "v", language: "plpgsql" });
    expect(byName.get("require_read_committed")).toEqual({ volatility: "s", language: "plpgsql" });
    expect(byName.get("owner_window_decision")).toEqual({ volatility: "i", language: "sql" });
    expect(byName.get("checkout_transition")).toEqual({ volatility: "i", language: "sql" });
    expect(byName.get("quote_digest_saqd1")).toEqual({ volatility: "s", language: "sql" });
    expect(byName.get("descriptive_terms_digest")).toEqual({ volatility: "s", language: "sql" });
    expect(byName.get("quote_material_change")).toEqual({ volatility: "s", language: "sql" });

    // Table-level privileges of the function owner: Increment 1's, and exactly those of 19.13. No DELETE on any of
    // the seven tables, and no table-level UPDATE on the request windows or on the challenges. INSERT on the
    // challenges comes from migration 0009; its UPDATE there is by column and is asserted in privileges.test.ts.
    const held = (await db.admin.query(SQL.definerTableGrants)).rows.map((row) => row.held);
    expect(held).toEqual(
      [
        "audit_events:INSERT",
        "checkout_intents:INSERT",
        "checkout_intents:SELECT",
        "checkout_intents:UPDATE",
        "checkout_owners:INSERT",
        "checkout_owners:SELECT",
        "checkout_owners:UPDATE",
        "checkout_transitions:INSERT",
        "checkout_transitions:SELECT",
        "confirmation_challenges:INSERT",
        "confirmation_challenges:SELECT",
        "merchant_products:SELECT",
        "merchant_variants:SELECT",
        "merchants:SELECT",
        "owner_request_windows:INSERT",
        "owner_request_windows:SELECT",
        "purchase_groups:INSERT",
        "purchase_groups:SELECT",
        "quote_items:INSERT",
        "quote_items:SELECT",
        "quotes:INSERT",
        "quotes:SELECT",
        "server_key_versions:INSERT",
        "server_key_versions:SELECT",
        "server_key_versions:UPDATE",
        "session_admission_guard:SELECT",
        "session_admission_guard:UPDATE",
        "shopper_sessions:DELETE",
        "shopper_sessions:INSERT",
        "shopper_sessions:SELECT",
        "shopper_sessions:UPDATE",
      ].sort(),
    );
    // Column-level UPDATE on the five non-key columns only: the owner of a window cannot be changed.
    expect((await db.admin.query(SQL.definerColumnGrants)).rows.map((row) => row.held)).toEqual(
      [
        "owner_request_windows.total_throttled:UPDATE",
        "owner_request_windows.updated_at:UPDATE",
        "owner_request_windows.window_calls:UPDATE",
        "owner_request_windows.window_started_at:UPDATE",
        "owner_request_windows.window_throttled:UPDATE",
      ].sort(),
    );
    // No runtime role has any table privilege on the seven tables.
    expect((await db.admin.query(SQL.runtimeTableGrants)).rows).toEqual([]);
    // A runtime role cannot reach a helper.
    expect(await sqlState(() => db.web.query(SQL.guardAsWeb))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlState(() => db.web.query(SQL.windowDecisionNoRow))).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("PGT-111 and PGT-140: a new checkout is exactly one group, intent, quote, item, transition and audit row, and its owner can read and list it", async () => {
    const credential = await newCredential(db.admin);
    const other = await newCredential(db.admin);
    expect(await windowOf(db.admin, credential.owner)).toBeNull();

    const started = await startCheckout(db.web, credential);
    expect(started.result).toBe("STARTED");
    expect(started.intent_id).toMatch(/^ci_[0-9a-f]{32}$/);
    expect(started.quote_id).toMatch(/^qt_[0-9a-f]{32}$/);
    const intentId = started.intent_id as string;

    expect(await countsOf(db.admin, credential.owner)).toEqual({ groups: 1, intents: 1, quotes: 1, audits: 1 });
    const intent = await intentOf(db.admin, intentId);
    expect(intent).toMatchObject({
      state: "QUOTED",
      row_version: 2,
      owner_id: credential.owner,
      replaces_intent_id: null,
      superseded_by_intent_id: null,
      current_quote_id: started.quote_id,
      confirmation_id: null,
      confirmation_status: null,
      created_by_session_id: credential.session,
    });
    expect(intent.updated_at.getTime()).toBe(intent.created_at.getTime());

    const quote = (await db.admin.query(SQL.quoteRow, [intentId])).rows[0];
    expect(quote).toMatchObject({
      id: started.quote_id,
      owner_id: credential.owner,
      merchant_id: MERCHANT,
      catalog_revision: 1,
      subtotal_cents: UNIT_AMOUNT,
      discount_cents: 0,
      tax_cents: 0,
      shipping_cents: 0,
      total_cents: UNIT_AMOUNT,
      currency: "USD",
      assumptions_code: ASSUMPTIONS,
      digest_version: "SAQD-1",
      lifetime_exact: true,
    });
    // One clock reading: the quote, the intent and the returned expiry agree.
    expect(quote.created_at.getTime()).toBe(intent.created_at.getTime());
    expect((started.quote_expires_at as Date).getTime()).toBe(quote.expires_at.getTime());
    // The stored digest is SAQD-1 of the stored fields.
    const digests = (await db.admin.query(SQL.saqdOfStoredQuote, [intentId])).rows[0];
    expect(digests.computed).toBe(digests.stored);

    const items = (await db.admin.query(SQL.itemRows, [started.quote_id])).rows;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ line_number: 1, product_id: PRODUCT, variant_id: VARIANT, quantity: 1, unit_amount_cents: UNIT_AMOUNT, line_subtotal_cents: UNIT_AMOUNT });
    const catalog = (await db.admin.query(SQL.variantCatalog, [VARIANT])).rows[0];
    expect(items[0]).toMatchObject({ merchant_display_name: catalog.display_name, product_title: catalog.title, variant_label: catalog.label });
    expect(items[0].descriptive_terms_digest).toBe((await db.admin.query(SQL.sadtOfVariant, [VARIANT])).rows[0].digest);

    const transitions = (await db.admin.query(SQL.transitionRows, [intentId])).rows;
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      to_version: 2,
      from_version: 1,
      event_type: "QUOTE_ISSUED",
      actor: "server",
      entry_point: "start_checkout",
      from_state: "DRAFT",
      to_state: "QUOTED",
      times_equal: true,
    });

    const audit = await auditOf(db.admin, credential.owner);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      event_type: "QUOTE_ISSUED",
      actor: "server",
      session_id: credential.session,
      owner_id: credential.owner,
      checkout_intent_id: intentId,
      operation_id: null,
      times_equal: true,
    });
    expect(audit[0].event_id).toMatch(/^ev_[0-9a-f]{32}$/);
    expect(sortedKeys(audit[0].detail)).toEqual(["productId", "purchaseGroupId", "quantity", "quoteId", "totalCents", "transitionEventId", "variantId"]);
    expect(audit[0].detail).toMatchObject({
      transitionEventId: transitions[0].event_id,
      quoteId: started.quote_id,
      purchaseGroupId: intent.purchase_group_id,
      productId: PRODUCT,
      variantId: VARIANT,
      quantity: 1,
      totalCents: UNIT_AMOUNT,
    });
    // No digest of any kind in the detail.
    expect(JSON.stringify(audit[0].detail)).not.toMatch(/[0-9a-f]{64}/);

    // The request window: the first admitted call created the row, with one call (PGT-144b).
    expect(await windowOf(db.admin, credential.owner)).toMatchObject({ window_calls: 1, window_throttled: 0, total_throttled: 0, ordered: true });
    // No session touch: the functions never update a session row.
    expect((await db.admin.query(SQL.sessionRow, [credential.session])).rows[0]).toMatchObject({ row_version: 1, revoked_at: null });

    const read = await readCheckout(db.web, credential, intentId);
    // 41 columns since migration 0009: the 33 of Increment 2.1 and eight for the quote's ACTIVE challenge. This
    // checkout has no challenge: the seven challenge columns are NULL and it is not usable.
    expect(Object.keys(read)).toHaveLength(41);
    expect(Object.keys(read).slice(33)).toEqual([
      "challenge_id",
      "challenge_quote_digest",
      "challenge_nonce_key_version",
      "challenge_nonce_digest",
      "challenge_summary",
      "challenge_issued_at",
      "challenge_expires_at",
      "challenge_usable",
    ]);
    expect(read).toMatchObject({
      challenge_id: null,
      challenge_quote_digest: null,
      challenge_nonce_key_version: null,
      challenge_nonce_digest: null,
      challenge_summary: null,
      challenge_issued_at: null,
      challenge_expires_at: null,
      challenge_usable: false,
    });
    expect(read).toMatchObject({
      result: "OK",
      owner_id: credential.owner,
      intent_id: intentId,
      purchase_group_id: intent.purchase_group_id,
      stored_state: "QUOTED",
      row_version: 2,
      effective_status: "QUOTED",
      replaces_intent_id: null,
      superseded_by_intent_id: null,
      quote_id: started.quote_id,
      merchant_id: MERCHANT,
      product_id: PRODUCT,
      variant_id: VARIANT,
      quantity: 1,
      currency: "USD",
      assumptions_code: ASSUMPTIONS,
      catalog_revision: 1,
      quote_digest: quote.digest,
      quote_stale: false,
    });
    // bigint columns arrive as text from the driver.
    expect([read.unit_amount_cents, read.subtotal_cents, read.discount_cents, read.tax_cents, read.shipping_cents, read.total_cents].map(Number)).toEqual([UNIT_AMOUNT, UNIT_AMOUNT, 0, 0, 0, UNIT_AMOUNT]);
    expect(read.intent_created_at.getTime()).toBe(intent.created_at.getTime());
    expect(read.quote_expires_at.getTime()).toBe(quote.expires_at.getTime());
    expect(read.database_time).toBeInstanceOf(Date);

    // The list: own rows only; none for another owner; none without a valid credential.
    const listed = await listCheckouts(db.web, credential);
    expect(listed).toHaveLength(1);
    expect(Object.keys(listed[0])).toEqual(["intent_id", "purchase_group_id", "stored_state", "effective_status", "intent_created_at", "quote_expires_at"]);
    expect(listed[0]).toMatchObject({ intent_id: intentId, stored_state: "QUOTED", effective_status: "QUOTED" });
    expect(await listCheckouts(db.web, other)).toEqual([]);
    expect(await listCheckouts(db.web, { ...credential, digest: hex(32) })).toEqual([]);

    // Another owner's intent is unreachable (PGT-69c): one row, NOT_AUTHORIZED, every other column NULL.
    const foreign = await readCheckout(db.web, other, intentId);
    expect(foreign.result).toBe("NOT_AUTHORIZED");
    expect(Object.entries(foreign).filter(([name, value]) => name !== "result" && value !== null)).toEqual([]);
    // The same row for a missing intent, a malformed one and none at all.
    for (const intentArgument of [newId("ci"), "not-an-intent", null]) {
      const row = await readCheckout(db.web, credential, intentArgument);
      expect(row.result, String(intentArgument)).toBe("NOT_AUTHORIZED");
      expect(row.database_time, String(intentArgument)).toBeNull();
    }
    // Reads change nothing and take no lock that outlives them.
    expect(await countsOf(db.admin, credential.owner)).toEqual({ groups: 1, intents: 1, quotes: 1, audits: 1 });
  });

  it("list_owner_checkouts returns the newest first", async () => {
    const credential = await newCredential(db.admin);
    const older = await insertFixtureCheckout(db.admin, credential, minutesAgo(5), false);
    const newer = await insertFixtureCheckout(db.admin, credential, minutesAgo(1), false);
    const expired = await insertFixtureCheckout(db.admin, credential, minutesAgo(40), false);
    const listed = await listCheckouts(db.web, credential);
    expect(listed.map((row) => row.intent_id)).toEqual([newer.intent, older.intent, expired.intent]);
    expect(listed.map((row) => row.effective_status)).toEqual(["QUOTED", "QUOTED", "QUOTE_EXPIRED"]);
    expect(listed.map((row) => row.stored_state)).toEqual(["QUOTED", "QUOTED", "QUOTED"]);
  });

  it("PGT-73a (database side): quote_digest_saqd1 gives the three digests of specification 15.2, whatever the session settings", async () => {
    const common = {
      owner: `own_${"2".repeat(32)}`,
      intent: `ci_${"3".repeat(32)}`,
      group: `pur_${"4".repeat(32)}`,
      created: "1791460800000000",
      expires: "1791461700000000",
    };
    const vector = (quote: string, quantity: number, unit: number, subtotal: number): unknown[] => [
      quote,
      common.owner,
      common.intent,
      common.group,
      MERCHANT,
      PRODUCT,
      VARIANT,
      1,
      quantity,
      unit,
      subtotal,
      0,
      0,
      0,
      subtotal,
      "USD",
      ASSUMPTIONS,
      common.created,
      common.expires,
    ];
    const v1 = vector(`qt_${"1".repeat(32)}`, 1, 79900, 79900);
    const v2 = vector(`qt_${"a".repeat(32)}`, 2, 79900, 159800);
    const v3 = vector(`qt_${"1".repeat(32)}`, 1, 79901, 79901);

    expect((await db.admin.query(SQL.saqd, v1)).rows[0].digest).toBe(SAQD_V1);
    expect((await db.admin.query(SQL.saqd, v2)).rows[0].digest).toBe(SAQD_V2);
    expect((await db.admin.query(SQL.saqd, v3)).rows[0].digest).toBe(SAQD_V3);

    // The same digests under another time zone and date style: the helper depends on neither.
    await db.admin.query(SQL.setTimeZoneKolkata);
    await db.admin.query(SQL.setDateStyleGerman);
    try {
      expect((await db.admin.query(SQL.saqd, v1)).rows[0].digest).toBe(SAQD_V1);
      expect((await db.admin.query(SQL.saqd, v2)).rows[0].digest).toBe(SAQD_V2);
      expect((await db.admin.query(SQL.saqd, v3)).rows[0].digest).toBe(SAQD_V3);
    } finally {
      await db.admin.query(SQL.resetTimeZone);
      await db.admin.query(SQL.resetDateStyle);
    }
    // A missing field gives no digest at all, never a digest over fewer fields.
    const withoutCurrency = [...v1];
    withoutCurrency[15] = null;
    expect((await db.admin.query(SQL.saqd, withoutCurrency)).rows[0].digest).toBeNull();
  });

  it("PGT-120 (digest part): descriptive_terms_digest computes the two proposed SADT-1 targets in the database", async () => {
    // What PostgreSQL actually prints for the seeded specifications is recorded with the result, so that a mismatch
    // can be investigated from the log of the run.
    const seeded = (await db.admin.query(SQL.sadtOfVariant, [VARIANT])).rows[0];
    const catalog = (await db.admin.query(SQL.variantCatalog, [VARIANT])).rows[0];
    const d2 = (await db.admin.query(SQL.sadt, ["Café laptop – 15″", JSON.stringify({ note: "é" })])).rows[0];
    console.info(
      `SADT-1 as observed (targets are proposed, not PostgreSQL-verified): ${JSON.stringify({
        serverEncoding: catalog.server_encoding,
        d1: { description: seeded.description, specsText: seeded.specs_text, digest: seeded.digest, target: SADT_D1 },
        d2: { specsText: d2.specs_text, digest: d2.digest, target: SADT_D2 },
      })}`,
    );
    expect(catalog.server_encoding).toBe("UTF8");
    expect(seeded.digest, SADT_NOTE).toBe(SADT_D1);
    expect(d2.digest, SADT_NOTE).toBe(SADT_D2);

    await db.admin.query(SQL.setTimeZoneKolkata);
    await db.admin.query(SQL.setDateStyleGerman);
    try {
      expect((await db.admin.query(SQL.sadtOfVariant, [VARIANT])).rows[0].digest).toBe(seeded.digest);
    } finally {
      await db.admin.query(SQL.resetTimeZone);
      await db.admin.query(SQL.resetDateStyle);
    }
  });

  it("PGT-120: every material change makes a quote stale, a cosmetic one does not, and the stored snapshot does not move", async () => {
    const credential = await newCredential(db.admin);
    const started = await startCheckout(db.web, credential);
    const intentId = started.intent_id as string;
    const original = (await db.admin.query(SQL.variantCatalog, [VARIANT])).rows[0];
    const before = await readCheckout(db.web, credential, intentId);
    expect(before.quote_stale).toBe(false);
    const stale = async (): Promise<boolean> => (await readCheckout(db.web, credential, intentId)).quote_stale;

    try {
      // Unit amount, raised and lowered; then put back: no history is kept.
      await db.admin.query(SQL.setVariantAmount, [VARIANT, original.unit_amount_cents + 1]);
      expect(await stale(), "amount raised").toBe(true);
      await db.admin.query(SQL.setVariantAmount, [VARIANT, original.unit_amount_cents - 1]);
      expect(await stale(), "amount lowered").toBe(true);
      await db.admin.query(SQL.setVariantAmount, [VARIANT, original.unit_amount_cents]);
      expect(await stale(), "amount put back").toBe(false);

      await db.admin.query(SQL.setVariantAvailability, [VARIANT, "OUT_OF_STOCK"]);
      expect(await stale(), "out of stock").toBe(true);
      await db.admin.query(SQL.setVariantAvailability, [VARIANT, "DISCONTINUED"]);
      expect(await stale(), "discontinued").toBe(true);
      await db.admin.query(SQL.setVariantAvailability, [VARIANT, original.availability]);

      // The quoted quantity is 1: a limit of 1 is still sufficient, and a higher one is not a change that matters.
      await db.admin.query(SQL.setVariantLimit, [VARIANT, 1]);
      expect(await stale(), "limit lowered but sufficient").toBe(false);
      await db.admin.query(SQL.setVariantLimit, [VARIANT, 5]);
      expect(await stale(), "limit raised").toBe(false);
      await db.admin.query(SQL.setVariantLimit, [VARIANT, original.max_quantity_per_order]);

      await db.admin.query(SQL.setMerchantName, [MERCHANT, "Another Name"]);
      expect(await stale(), "merchant display name").toBe(true);
      await db.admin.query(SQL.setMerchantName, [MERCHANT, original.display_name]);

      await db.admin.query(SQL.setProductTitle, [PRODUCT, "Another Title"]);
      expect(await stale(), "product title").toBe(true);
      // The snapshot the buyer was quoted is returned unchanged after the rename.
      expect((await readCheckout(db.web, credential, intentId)).product_title).toBe(before.product_title);
      await db.admin.query(SQL.setProductTitle, [PRODUCT, original.title]);

      await db.admin.query(SQL.setVariantLabel, [VARIANT, "Another Label"]);
      expect(await stale(), "variant label").toBe(true);
      await db.admin.query(SQL.setVariantLabel, [VARIANT, original.label]);

      await db.admin.query(SQL.setProductDescription, [PRODUCT, `${original.description} Changed.`]);
      expect(await stale(), "product description").toBe(true);
      await db.admin.query(SQL.setProductDescription, [PRODUCT, original.description]);

      const specs = JSON.parse(original.specs_text) as Record<string, unknown>;
      await db.admin.query(SQL.setVariantSpecs, [VARIANT, JSON.stringify({ ...specs, ramGb: 64 })]);
      expect(await stale(), "one specification value").toBe(true);
      // The same content with its keys in another order is the same value to PostgreSQL.
      const reordered = Object.fromEntries(Object.entries(specs).reverse());
      await db.admin.query(SQL.setVariantSpecs, [VARIANT, JSON.stringify(reordered)]);
      expect(await stale(), "specifications reordered").toBe(false);
      await db.admin.query(SQL.setVariantSpecs, [VARIANT, original.specs_text]);

      // The product moved to another merchant: the merchant ID (and with it the display name) no longer matches.
      const secondMerchant = "dmm_secondmerchant";
      await db.admin.query(SQL.addMerchant, [secondMerchant]);
      try {
        await db.admin.query(SQL.setProductMerchant, [PRODUCT, secondMerchant]);
        expect(await stale(), "product moved to a second merchant").toBe(true);
        // The quote keeps the merchant it was made for.
        expect((await readCheckout(db.web, credential, intentId)).merchant_id).toBe(MERCHANT);
      } finally {
        await db.admin.query(SQL.setProductMerchant, [PRODUCT, MERCHANT]);
        await db.admin.query(SQL.removeMerchant, [secondMerchant]);
      }
      expect(await stale(), "product moved back").toBe(false);

      // A limit lowered below the quoted quantity: a second checkout for two, then a limit of one.
      const forTwo = await startCheckout(db.web, credential, PRODUCT, VARIANT, 2);
      expect(forTwo.result).toBe("STARTED");
      expect((await readCheckout(db.web, credential, forTwo.intent_id)).quote_stale).toBe(false);
      await db.admin.query(SQL.setVariantLimit, [VARIANT, 1]);
      expect((await readCheckout(db.web, credential, forTwo.intent_id)).quote_stale, "limit below the quoted quantity").toBe(true);
      expect(await stale(), "the same limit, for a quantity of one").toBe(false);
      await db.admin.query(SQL.setVariantLimit, [VARIANT, original.max_quantity_per_order]);
      expect((await readCheckout(db.web, credential, forTwo.intent_id)).quote_stale).toBe(false);

      // Cosmetic: image path, and either revision number alone.
      await db.admin.query(SQL.setProductImage, [PRODUCT, "/catalog/another-image.svg"]);
      expect(await stale(), "image path").toBe(false);
      await db.admin.query(SQL.setProductImage, [PRODUCT, original.image_path]);
      await db.admin.query(SQL.setProductRevision, [PRODUCT, original.product_revision + 1]);
      expect(await stale(), "product revision").toBe(false);
      await db.admin.query(SQL.setProductRevision, [PRODUCT, original.product_revision]);
      await db.admin.query(SQL.setVariantRevision, [VARIANT, original.variant_revision + 1]);
      expect(await stale(), "variant revision").toBe(false);
      await db.admin.query(SQL.setVariantRevision, [VARIANT, original.variant_revision]);
    } finally {
      // Put everything back, whatever happened above. Each statement writes the original value.
      await db.admin.query(SQL.setVariantAmount, [VARIANT, original.unit_amount_cents]);
      await db.admin.query(SQL.setVariantAvailability, [VARIANT, original.availability]);
      await db.admin.query(SQL.setVariantLimit, [VARIANT, original.max_quantity_per_order]);
      await db.admin.query(SQL.setVariantLabel, [VARIANT, original.label]);
      await db.admin.query(SQL.setVariantSpecs, [VARIANT, original.specs_text]);
      await db.admin.query(SQL.setVariantRevision, [VARIANT, original.variant_revision]);
      await db.admin.query(SQL.setProductTitle, [PRODUCT, original.title]);
      await db.admin.query(SQL.setProductDescription, [PRODUCT, original.description]);
      await db.admin.query(SQL.setProductImage, [PRODUCT, original.image_path]);
      await db.admin.query(SQL.setProductRevision, [PRODUCT, original.product_revision]);
      await db.admin.query(SQL.setMerchantName, [MERCHANT, original.display_name]);
    }
    const after = await readCheckout(db.web, credential, intentId);
    expect(after.quote_stale).toBe(false);
    // Staleness never changed anything stored.
    expect({ state: after.stored_state, version: after.row_version, digest: after.quote_digest }).toEqual({ state: "QUOTED", version: 2, digest: before.quote_digest });

    // The two facts the catalog's own constraints prevent producing by data, through the helper directly.
    const same: unknown[] = [UNIT_AMOUNT, "USD", 1, MERCHANT, PRODUCT, "Name", "Title", "Label", "Description", "{}", UNIT_AMOUNT, "USD", "IN_STOCK", 2, MERCHANT, PRODUCT, "Name", "Title", "Label", "Description", "{}"];
    expect((await db.admin.query(SQL.materialChange, same)).rows[0].stale).toBe(false);
    const otherCurrency = [...same];
    otherCurrency[11] = "EUR";
    expect((await db.admin.query(SQL.materialChange, otherCurrency)).rows[0].stale).toBe(true);
    const otherProduct = [...same];
    otherProduct[15] = "dmp_another01";
    expect((await db.admin.query(SQL.materialChange, otherProduct)).rows[0].stale).toBe(true);
    // A missing catalog row arrives as NULLs and is stale.
    const missing = [...same];
    for (const position of [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]) missing.splice(position, 1, null);
    expect((await db.admin.query(SQL.materialChange, missing)).rows[0].stale).toBe(true);
  });

  it("PGT-119: quote expiry is derived, is reported as QUOTE_EXPIRED, and changes nothing stored", async () => {
    const credential = await newCredential(db.admin);
    const fresh = await insertFixtureCheckout(db.admin, credential, minutesAgo(1), false);
    const expired = await insertFixtureCheckout(db.admin, credential, minutesAgo(20), false);
    const confirmedExpired = await insertFixtureCheckout(db.admin, credential, minutesAgo(30), true);

    expect(await readCheckout(db.web, credential, fresh.intent)).toMatchObject({ result: "OK", stored_state: "QUOTED", effective_status: "QUOTED", quote_stale: false });
    expect(await readCheckout(db.web, credential, expired.intent)).toMatchObject({ result: "OK", stored_state: "QUOTED", effective_status: "QUOTE_EXPIRED", quote_stale: false });
    expect(await readCheckout(db.web, credential, confirmedExpired.intent)).toMatchObject({ result: "OK", stored_state: "USER_CONFIRMED", effective_status: "QUOTE_EXPIRED", row_version: 3 });
    // Stored states are untouched by expiry.
    expect((await intentOf(db.admin, expired.intent)).state).toBe("QUOTED");
    expect((await intentOf(db.admin, confirmedExpired.intent)).state).toBe("USER_CONFIRMED");
  });

  it("PGT-142: a predecessor whose quote has expired is replaced, stored as QUOTED and stored as USER_CONFIRMED, and keeps its confirmation pointer", async () => {
    for (const confirmed of [false, true]) {
      const label = confirmed ? "USER_CONFIRMED" : "QUOTED";
      const credential = await newCredential(db.admin);
      const fixture = await insertFixtureCheckout(db.admin, credential, minutesAgo(20), confirmed);
      const predecessorBefore = await intentOf(db.admin, fixture.intent);
      const quoteBefore = (await db.admin.query(SQL.quoteRow, [fixture.intent])).rows[0];
      const auditBefore = await auditOf(db.admin, credential.owner);
      // The fixture is internally consistent before the call.
      expect(auditBefore.filter((row) => row.event_type === "QUOTE_ISSUED" && row.checkout_intent_id === fixture.intent), label).toHaveLength(1);
      expect(auditBefore.filter((row) => row.event_type === "CONFIRMATION_ACCEPTED"), label).toHaveLength(confirmed ? 1 : 0);
      expect(JSON.stringify(auditBefore.map((row) => row.detail)), label).not.toMatch(/[A-Za-z0-9_-]{43}|[0-9a-f]{64}/);

      const replaced = await startCheckout(db.web, credential, PRODUCT, VARIANT, 1, fixture.intent);
      expect(replaced.result, label).toBe("STARTED");
      const successorId = replaced.intent_id as string;

      const successor = await intentOf(db.admin, successorId);
      expect(successor, label).toMatchObject({
        state: "QUOTED",
        row_version: 2,
        purchase_group_id: fixture.group,
        replaces_intent_id: fixture.intent,
        superseded_by_intent_id: null,
        confirmation_id: null,
        confirmation_status: null,
      });
      const predecessor = await intentOf(db.admin, fixture.intent);
      expect(predecessor, label).toMatchObject({
        state: "SUPERSEDED",
        row_version: predecessorBefore.row_version + 1,
        superseded_by_intent_id: successorId,
        // Supersession never clears a confirmation pointer.
        confirmation_id: fixture.challenge,
        confirmation_status: confirmed ? "CONSUMED" : null,
      });
      // The predecessor's quote row is unchanged, and the successor has a new quote from the current catalog.
      expect((await db.admin.query(SQL.quoteRow, [fixture.intent])).rows[0].row_digest, label).toBe(quoteBefore.row_digest);
      const successorQuote = (await db.admin.query(SQL.quoteRow, [successorId])).rows[0];
      expect(successorQuote.id, label).not.toBe(fixture.quote);
      expect(successorQuote.lifetime_exact, label).toBe(true);

      const predecessorTransitions = (await db.admin.query(SQL.transitionRows, [fixture.intent])).rows;
      expect(predecessorTransitions.at(-1), label).toMatchObject({
        event_type: "SUPERSEDED",
        actor: "server",
        entry_point: "start_checkout",
        from_state: label,
        to_state: "SUPERSEDED",
        from_version: predecessorBefore.row_version,
        to_version: predecessorBefore.row_version + 1,
        times_equal: true,
      });

      // Audit: the fixture's synthetic rows are unchanged, and exactly two rows are added.
      const auditAfter = await auditOf(db.admin, credential.owner);
      expect(auditAfter.slice(0, auditBefore.length), label).toEqual(auditBefore);
      const added = auditAfter.slice(auditBefore.length);
      expect(added.map((row) => `${row.event_type}:${row.checkout_intent_id}`).sort(), label).toEqual([`CHECKOUT_SUPERSEDED:${fixture.intent}`, `QUOTE_ISSUED:${successorId}`].sort());
      const superseded = added.find((row) => row.event_type === "CHECKOUT_SUPERSEDED");
      expect(superseded, label).toMatchObject({ actor: "server", session_id: credential.session, owner_id: credential.owner, times_equal: true });
      expect(sortedKeys(superseded.detail), label).toEqual(["supersededByIntentId", "transitionEventId"]);
      expect(superseded.detail, label).toMatchObject({ supersededByIntentId: successorId, transitionEventId: predecessorTransitions.at(-1).event_id });

      // Reads agree, and a second replacement of the same predecessor is refused (PGT-114): counted, nothing else.
      expect(await readCheckout(db.web, credential, fixture.intent), label).toMatchObject({ stored_state: "SUPERSEDED", effective_status: "SUPERSEDED", superseded_by_intent_id: successorId });
      const countsBefore = await countsOf(db.admin, credential.owner);
      const windowBefore = await windowOf(db.admin, credential.owner);
      expect((await startCheckout(db.web, credential, PRODUCT, VARIANT, 1, fixture.intent)).result, label).toBe("REPLACEMENT_NOT_ALLOWED");
      // PGT-137: a SUPERSEDED checkout is not cancelable either. Counted, and nothing else.
      expect(await cancelCheckout(db.web, credential, fixture.intent), label).toBe("NOT_CANCELABLE");
      expect(await countsOf(db.admin, credential.owner), label).toEqual(countsBefore);
      expect((await windowOf(db.admin, credential.owner)).window_calls, label).toBe(windowBefore.window_calls + 2);
      expect(await intentOf(db.admin, fixture.intent), label).toEqual(predecessor);
    }
  });

  it("PGT-137 and PGT-114: cancel succeeds from QUOTED and from USER_CONFIRMED, keeps the confirmation pointer, and a terminal checkout is neither cancelable nor replaceable", async () => {
    const credential = await newCredential(db.admin);
    const started = await startCheckout(db.web, credential);
    const quotedId = started.intent_id as string;
    const before = await intentOf(db.admin, quotedId);

    expect(await cancelCheckout(db.web, credential, quotedId)).toBe("CANCELED");
    const canceled = await intentOf(db.admin, quotedId);
    expect(canceled).toMatchObject({ state: "CANCELED_LOCAL", row_version: 3, superseded_by_intent_id: null, confirmation_id: null, current_quote_id: before.current_quote_id });
    const transitions = (await db.admin.query(SQL.transitionRows, [quotedId])).rows;
    expect(transitions).toHaveLength(2);
    expect(transitions[1]).toMatchObject({
      event_type: "SHOPPER_CANCELED",
      actor: "shopper",
      entry_point: "cancel_checkout",
      from_state: "QUOTED",
      to_state: "CANCELED_LOCAL",
      from_version: 2,
      to_version: 3,
      times_equal: true,
    });
    const audit = await auditOf(db.admin, credential.owner);
    expect(audit.map((row) => row.event_type)).toEqual(["QUOTE_ISSUED", "CHECKOUT_CANCELED"]);
    expect(audit[1]).toMatchObject({ actor: "shopper", session_id: credential.session, checkout_intent_id: quotedId, times_equal: true });
    expect(sortedKeys(audit[1].detail)).toEqual(["fromState", "transitionEventId"]);
    expect(audit[1].detail).toEqual({ fromState: "QUOTED", transitionEventId: transitions[1].event_id });

    // Terminal: not cancelable again, not replaceable. Each refusal is counted and changes nothing else.
    const countsBefore = await countsOf(db.admin, credential.owner);
    const callsBefore = (await windowOf(db.admin, credential.owner)).window_calls;
    expect(await cancelCheckout(db.web, credential, quotedId)).toBe("NOT_CANCELABLE");
    expect((await startCheckout(db.web, credential, PRODUCT, VARIANT, 1, quotedId)).result).toBe("REPLACEMENT_NOT_ALLOWED");
    expect(await countsOf(db.admin, credential.owner)).toEqual(countsBefore);
    expect((await windowOf(db.admin, credential.owner)).window_calls).toBe(callsBefore + 2);
    expect(await intentOf(db.admin, quotedId)).toEqual(canceled);

    // From USER_CONFIRMED, with an expired quote: cancelable, and the confirmation pointer is exactly as it was.
    const confirmed = await insertFixtureCheckout(db.admin, credential, minutesAgo(20), true);
    expect(await cancelCheckout(db.web, credential, confirmed.intent)).toBe("CANCELED");
    expect(await intentOf(db.admin, confirmed.intent)).toMatchObject({
      state: "CANCELED_LOCAL",
      row_version: 4,
      confirmation_id: confirmed.challenge,
      confirmation_status: "CONSUMED",
    });
    expect((await db.admin.query(SQL.transitionRows, [confirmed.intent])).rows.at(-1)).toMatchObject({ from_state: "USER_CONFIRMED", to_state: "CANCELED_LOCAL", from_version: 3, to_version: 4 });
    expect(await readCheckout(db.web, credential, confirmed.intent)).toMatchObject({ stored_state: "CANCELED_LOCAL", effective_status: "CANCELED_LOCAL" });
  });

  it("PGT-137 and PGT-142 (variants: the predecessor was confirmed through issue_challenge and consume_challenge): cancel and replace succeed and keep the confirmation pointer", async () => {
    // The fixtures above write a USER_CONFIRMED checkout directly, with an expired quote. These two are confirmed by
    // the real functions of migration 0009, so their quotes are not expired: they add the real path, and do not
    // replace the fixtures. A real confirmed checkout whose quote has also expired cannot be produced without
    // waiting fifteen minutes, and is not claimed here.
    const confirmThroughTheFunctions = async (credential: Credential): Promise<{ intent: string; quote: string; challenge: string }> => {
      const started = await startCheckout(db.web, credential);
      const intent = started.intent_id as string;
      const challenge = newId("cf");
      const nonce = `${hex(21)}A`;
      const nonceDigest = (await db.admin.query(SQL.nonceDigestOf, [nonce])).rows[0].digest;
      const issued = (await db.web.query(SQL.issueChallengeCall, [KEY_VERSION, credential.digest, intent, challenge, 1, nonceDigest])).rows[0];
      expect(issued).toMatchObject({ result: "ISSUED", challenge_id: challenge, nonce_key_version: 1, nonce_digest: nonceDigest });
      const confirmed = (await db.web.query(SQL.consumeChallengeCall, [KEY_VERSION, credential.digest, challenge, nonce, started.quote_id, issued.quote_digest])).rows;
      expect(confirmed).toEqual([{ result: "CONFIRMED", intent_id: intent }]);
      expect(await intentOf(db.admin, intent)).toMatchObject({ state: "USER_CONFIRMED", row_version: 3, confirmation_id: challenge, confirmation_status: "CONSUMED" });
      return { intent, quote: started.quote_id as string, challenge };
    };

    // PGT-137: cancel from a really confirmed checkout.
    const canceling = await newCredential(db.admin);
    const toCancel = await confirmThroughTheFunctions(canceling);
    expect(await cancelCheckout(db.web, canceling, toCancel.intent)).toBe("CANCELED");
    expect(await intentOf(db.admin, toCancel.intent)).toMatchObject({
      state: "CANCELED_LOCAL",
      row_version: 4,
      confirmation_id: toCancel.challenge,
      confirmation_status: "CONSUMED",
      current_quote_id: toCancel.quote,
      superseded_by_intent_id: null,
    });
    expect((await db.admin.query(SQL.challengeRow, [toCancel.challenge])).rows).toEqual([{ status: "CONSUMED", checkout_intent_id: toCancel.intent, quote_id: toCancel.quote, owner_id: canceling.owner, consumed: true }]);
    expect((await db.admin.query(SQL.transitionRows, [toCancel.intent])).rows.map((row) => `${row.event_type}:${row.from_version}>${row.to_version}:${row.entry_point}`)).toEqual([
      "QUOTE_ISSUED:1>2:start_checkout",
      "SHOPPER_CONFIRMED:2>3:consume_challenge",
      "SHOPPER_CANCELED:3>4:cancel_checkout",
    ]);
    expect((await auditOf(db.admin, canceling.owner)).map((row) => row.event_type)).toEqual(["QUOTE_ISSUED", "CONFIRMATION_ACCEPTED", "CHECKOUT_CANCELED"]);
    expect(await cancelCheckout(db.web, canceling, toCancel.intent)).toBe("NOT_CANCELABLE");

    // PGT-142: replacement of a really confirmed predecessor (its quote not expired).
    const replacing = await newCredential(db.admin);
    const predecessor = await confirmThroughTheFunctions(replacing);
    const replaced = await startCheckout(db.web, replacing, PRODUCT, VARIANT, 1, predecessor.intent);
    expect(replaced.result).toBe("STARTED");
    const successor = replaced.intent_id as string;
    expect(await intentOf(db.admin, predecessor.intent)).toMatchObject({
      state: "SUPERSEDED",
      row_version: 4,
      confirmation_id: predecessor.challenge,
      confirmation_status: "CONSUMED",
      current_quote_id: predecessor.quote,
      superseded_by_intent_id: successor,
    });
    expect(await intentOf(db.admin, successor)).toMatchObject({ state: "QUOTED", row_version: 2, confirmation_id: null, confirmation_status: null, replaces_intent_id: predecessor.intent });
    expect((await db.admin.query(SQL.challengeRow, [predecessor.challenge])).rows[0]).toMatchObject({ status: "CONSUMED", checkout_intent_id: predecessor.intent });
    expect((await db.admin.query(SQL.transitionRows, [predecessor.intent])).rows.map((row) => `${row.event_type}:${row.from_version}>${row.to_version}`)).toEqual(["QUOTE_ISSUED:1>2", "SHOPPER_CONFIRMED:2>3", "SUPERSEDED:3>4"]);
    expect((await auditOf(db.admin, replacing.owner)).map((row) => row.event_type).sort()).toEqual(["CHECKOUT_SUPERSEDED", "CONFIRMATION_ACCEPTED", "QUOTE_ISSUED", "QUOTE_ISSUED"]);
    // The successor has no challenge of its own, and the reader says so.
    expect(await readCheckout(db.web, replacing, successor)).toMatchObject({ stored_state: "QUOTED", challenge_id: null, challenge_usable: false });
    expect(await readCheckout(db.web, replacing, predecessor.intent)).toMatchObject({ stored_state: "SUPERSEDED", challenge_id: null, challenge_usable: false });
  });

  it("PGT-129, PGT-130 and PGT-131: malformed requests, missing and foreign intents, and dead sessions change nothing", async () => {
    const credential = await newCredential(db.admin);
    const other = await newCredential(db.admin);
    const mine = (await startCheckout(db.web, credential)).intent_id as string;
    const theirs = (await startCheckout(db.web, other)).intent_id as string;
    const before = await snapshotOf(db.admin);

    // REQUEST_INVALID, every rule of 19.7 in turn. Nothing is counted.
    const invalidStarts: Array<[string, unknown, unknown, unknown, unknown]> = [
      ["product pattern", "codebook15", VARIANT, 1, null],
      ["product missing", null, VARIANT, 1, null],
      ["variant pattern", PRODUCT, "DMV_CODEBOOK15A", 1, null],
      ["variant missing", PRODUCT, null, 1, null],
      ["quantity zero", PRODUCT, VARIANT, 0, null],
      ["quantity eleven", PRODUCT, VARIANT, 11, null],
      ["quantity missing", PRODUCT, VARIANT, null, null],
      ["predecessor pattern", PRODUCT, VARIANT, 1, "ci_short"],
    ];
    for (const [label, productId, variantId, quantity, replaces] of invalidStarts) {
      const { rows } = await db.web.query(SQL.startCheckout, [KEY_VERSION, credential.digest, productId, variantId, quantity, replaces]);
      expect(rows, label).toEqual([{ result: "REQUEST_INVALID", intent_id: null, quote_id: null, quote_expires_at: null }]);
    }
    for (const intentArgument of ["ci_short", null, `CI_${"0".repeat(32)}`]) {
      expect((await db.web.query(SQL.cancelCheckout, [KEY_VERSION, credential.digest, intentArgument])).rows, String(intentArgument)).toEqual([{ result: "REQUEST_INVALID" }]);
    }
    // Without a session that appears live, the same malformed request is NOT_AUTHORIZED instead.
    expect((await db.web.query(SQL.startCheckout, [KEY_VERSION, hex(32), "codebook15", VARIANT, 1, null])).rows[0].result).toBe("NOT_AUTHORIZED");
    expect((await db.web.query(SQL.cancelCheckout, [KEY_VERSION, "not-a-digest", "ci_short"])).rows[0].result).toBe("NOT_AUTHORIZED");
    expect((await db.web.query(SQL.cancelCheckout, [0, credential.digest, mine])).rows[0].result).toBe("NOT_AUTHORIZED");

    // A value that cannot become the parameter's type is an error from PostgreSQL, not a result.
    expect(await sqlState(() => db.web.query(SQL.startCheckoutTextQuantity, [KEY_VERSION, credential.digest, PRODUCT, VARIANT, "three", null]))).toBe("22P02");

    // A well-formed missing intent and another owner's intent: both NOT_AUTHORIZED, for cancel and for replacement.
    for (const target of [newId("ci"), theirs]) {
      expect(await cancelCheckout(db.web, credential, target), target).toBe("NOT_AUTHORIZED");
      expect((await startCheckout(db.web, credential, PRODUCT, VARIANT, 1, target)).result, target).toBe("NOT_AUTHORIZED");
    }
    expect(await snapshotOf(db.admin)).toEqual(before);

    // PGT-08: an expired, an idle and a revoked session create nothing and reach nothing.
    const expiredSession = await newCredential(db.admin, "-25 hours", NOW);
    const idleSession = await newCredential(db.admin, "-3 hours", "-150 minutes");
    const revoked = await newCredential(db.admin);
    await db.admin.query(SQL.revokeSessionDirectly, [revoked.session]);
    const beforeDead = await snapshotOf(db.admin);
    for (const dead of [expiredSession, idleSession, revoked]) {
      expect((await startCheckout(db.web, dead)).result).toBe("NOT_AUTHORIZED");
      expect(await cancelCheckout(db.web, dead, mine)).toBe("NOT_AUTHORIZED");
      expect((await readCheckout(db.web, dead, mine)).result).toBe("NOT_AUTHORIZED");
      expect(await listCheckouts(db.web, dead)).toEqual([]);
      expect(await windowOf(db.admin, dead.owner)).toBeNull();
    }
    expect(await snapshotOf(db.admin)).toEqual(beforeDead);

    // PGT-09: a checkout outlives the session that created it. A second session of the same owner reaches it.
    const second = await newCredential(db.admin, NOW, NOW, credential.owner);
    await db.admin.query(SQL.revokeSessionDirectly, [credential.session]);
    expect((await readCheckout(db.web, credential, mine)).result).toBe("NOT_AUTHORIZED");
    expect(await readCheckout(db.web, second, mine)).toMatchObject({ result: "OK", intent_id: mine, stored_state: "QUOTED" });
    // And it survives the deletion of that session row, as admission cleanup deletes dead sessions: the intent
    // keeps the session's id as information only, with no key to it.
    expect((await db.admin.query(SQL.deleteSession, [credential.session])).rowCount).toBe(1);
    expect((await db.admin.query(SQL.sessionRow, [credential.session])).rows).toEqual([]);
    expect(await intentOf(db.admin, mine)).toMatchObject({ state: "QUOTED", row_version: 2, created_by_session_id: credential.session });
    expect(await readCheckout(db.web, second, mine)).toMatchObject({ result: "OK", intent_id: mine, stored_state: "QUOTED" });
    expect(await cancelCheckout(db.web, second, mine)).toBe("CANCELED");
  });

  it("business results come in the order of 19.7: eligibility, then the catalog, then capacity, and only a capacity refusal is audited", async () => {
    const credential = await newCredential(db.admin);
    const original = (await db.admin.query(SQL.variantCatalog, [VARIANT])).rows[0];
    const expectCountedOnly = async (run: () => Promise<string>, expected: string): Promise<void> => {
      const counts = await countsOf(db.admin, credential.owner);
      const calls = (await windowOf(db.admin, credential.owner))?.window_calls ?? 0;
      expect(await run(), expected).toBe(expected);
      expect(await countsOf(db.admin, credential.owner), expected).toEqual(counts);
      expect((await windowOf(db.admin, credential.owner)).window_calls, expected).toBe(calls + 1);
    };

    // The catalog refusals, in their order. Each is admitted and counted, and writes nothing else.
    await expectCountedOnly(async () => (await startCheckout(db.web, credential, UNKNOWN_PRODUCT, UNKNOWN_VARIANT)).result, "PRODUCT_NOT_IN_MERCHANT_CATALOG");
    // A real variant under a product it does not belong to.
    await expectCountedOnly(async () => (await startCheckout(db.web, credential, "dmp_studybook14", VARIANT)).result, "PRODUCT_NOT_IN_MERCHANT_CATALOG");
    await expectCountedOnly(async () => (await startCheckout(db.web, credential, PRODUCT, VARIANT_LIMIT_ONE, 2)).result, "QUANTITY_EXCEEDS_LIMIT");
    await db.admin.query(SQL.setVariantAvailability, [VARIANT, "OUT_OF_STOCK"]);
    try {
      // Unavailable comes before the quantity limit.
      await expectCountedOnly(async () => (await startCheckout(db.web, credential, PRODUCT, VARIANT, 9)).result, "VARIANT_UNAVAILABLE");
    } finally {
      await db.admin.query(SQL.setVariantAvailability, [VARIANT, original.availability]);
    }

    // PGT-81a: ten unresolved groups are permitted; the eleventh is refused, with one audit row.
    for (let index = 0; index < 10; index += 1) expect((await startCheckout(db.web, credential)).result, `group ${index + 1}`).toBe("STARTED");
    expect(await countsOf(db.admin, credential.owner)).toEqual({ groups: 10, intents: 10, quotes: 10, audits: 10 });
    const atCapacity = await startCheckout(db.web, credential);
    expect(atCapacity).toEqual({ result: "AT_PURCHASE_CAPACITY", intent_id: null, quote_id: null, quote_expires_at: null });
    expect(await countsOf(db.admin, credential.owner)).toEqual({ groups: 10, intents: 10, quotes: 10, audits: 11 });
    const refusal = (await auditOf(db.admin, credential.owner)).at(-1);
    expect(refusal).toMatchObject({ event_type: "CHECKOUT_REFUSED_AT_CAPACITY", actor: "server", session_id: credential.session, owner_id: credential.owner, checkout_intent_id: null, times_equal: true });
    expect(refusal.detail).toEqual({ reason: "AT_PURCHASE_CAPACITY", limit: 10 });

    // Overlap: at capacity AND a product that does not exist. The catalog answers first, and nothing is audited.
    await expectCountedOnly(async () => (await startCheckout(db.web, credential, UNKNOWN_PRODUCT, UNKNOWN_VARIANT)).result, "PRODUCT_NOT_IN_MERCHANT_CATALOG");

    // A replacement creates no group, so it is not refused by the group capacity.
    const listed = await listCheckouts(db.web, credential);
    const replaced = await startCheckout(db.web, credential, PRODUCT, VARIANT, 1, listed[0].intent_id);
    expect(replaced.result).toBe("STARTED");
    // Canceling one resolves its group and makes room for one more.
    expect(await cancelCheckout(db.web, credential, listed[1].intent_id)).toBe("CANCELED");
    expect((await startCheckout(db.web, credential)).result).toBe("STARTED");
  });

  it("PGT-122 and PGT-123: a purchase group holds ten intents; the eleventh is refused with one audit row that names the group", async () => {
    const credential = await newCredential(db.admin);
    const bystander = await newCredential(db.admin);
    let latest = (await startCheckout(db.web, credential)).intent_id as string;
    const group = (await intentOf(db.admin, latest)).purchase_group_id;
    for (let index = 2; index <= 10; index += 1) {
      const next = await startCheckout(db.web, credential, PRODUCT, VARIANT, 1, latest);
      expect(next.result, `intent ${index}`).toBe("STARTED");
      latest = next.intent_id as string;
    }
    expect(await countsOf(db.admin, credential.owner)).toMatchObject({ groups: 1, intents: 10 });
    const auditBefore = await auditOf(db.admin, credential.owner);

    // Two refusals: exactly two new audit rows, each with its own id (no quota).
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      expect((await startCheckout(db.web, credential, PRODUCT, VARIANT, 1, latest)).result, `refusal ${attempt}`).toBe("GROUP_INTENT_LIMIT");
    }
    const added = (await auditOf(db.admin, credential.owner)).slice(auditBefore.length);
    expect(added).toHaveLength(2);
    expect(new Set(added.map((row) => row.event_id)).size).toBe(2);
    for (const row of added) {
      expect(row).toMatchObject({ event_type: "CHECKOUT_REFUSED_AT_CAPACITY", actor: "server", owner_id: credential.owner, checkout_intent_id: latest, times_equal: true });
      expect(row.detail).toEqual({ reason: "GROUP_INTENT_LIMIT", limit: 10, purchaseGroupId: group });
    }
    expect(await countsOf(db.admin, credential.owner)).toMatchObject({ groups: 1, intents: 10 });
    // No other new audit row for this owner, and none at all for any other owner.
    expect((await auditOf(db.admin, credential.owner)).length).toBe(auditBefore.length + 2);
    expect(await auditOf(db.admin, bystander.owner)).toEqual([]);
    // The predecessor is untouched by the refusals.
    expect(await intentOf(db.admin, latest)).toMatchObject({ state: "QUOTED", row_version: 2, superseded_by_intent_id: null });
    // An ineligible predecessor in the full group: eligibility answers first, and nothing is audited.
    const first = (await listCheckouts(db.web, credential)).at(-1);
    const auditCount = (await auditOf(db.admin, credential.owner)).length;
    expect((await startCheckout(db.web, credential, PRODUCT, VARIANT, 1, first.intent_id)).result).toBe("REPLACEMENT_NOT_ALLOWED");
    expect((await auditOf(db.admin, credential.owner)).length).toBe(auditCount);
  });

  it("PGT-124, PGT-125, PGT-144 and PGT-145 (forward time): thirty admitted calls per window, then RATE_LIMITED with one audit row", async () => {
    const credential = await newCredential(db.admin);
    // PGT-144a: a first call that is NOT_AUTHORIZED leaves no row.
    expect(await cancelCheckout(db.web, credential, newId("ci"))).toBe("NOT_AUTHORIZED");
    expect(await windowOf(db.admin, credential.owner)).toBeNull();

    for (let index = 1; index <= 5; index += 1) expect(await admittedCall(db.web, credential), `call ${index}`).toBe("PRODUCT_NOT_IN_MERCHANT_CATALOG");
    // PGT-145a: under the limit, NOT_AUTHORIZED and REQUEST_INVALID inside the window change no column and are not
    // counted: they consume none of the thirty.
    const partial = await windowOf(db.admin, credential.owner);
    expect(partial).toMatchObject({ window_calls: 5, window_throttled: 0, total_throttled: 0, ordered: true });
    expect(await cancelCheckout(db.web, credential, newId("ci"))).toBe("NOT_AUTHORIZED");
    expect((await startCheckout(db.web, credential, PRODUCT, VARIANT, 0)).result).toBe("REQUEST_INVALID");
    expect(await windowOf(db.admin, credential.owner)).toEqual(partial);
    for (let index = 6; index <= 30; index += 1) expect(await admittedCall(db.web, credential), `call ${index}`).toBe("PRODUCT_NOT_IN_MERCHANT_CATALOG");
    const full = await windowOf(db.admin, credential.owner);
    expect(full).toMatchObject({ window_calls: 30, window_throttled: 0, total_throttled: 0, ordered: true });
    expect(full.window_started_at.getTime()).toBe(partial.window_started_at.getTime());

    // The 31st call, and every later one in the window. Both mutating functions share the one counter. Over the
    // limit, a well-formed request for a missing intent is RATE_LIMITED too, before any resource is looked at (PGT-131).
    expect(await admittedCall(db.web, credential)).toBe("RATE_LIMITED");
    const first = await windowOf(db.admin, credential.owner);
    expect(first).toMatchObject({ window_calls: 30, window_throttled: 1, total_throttled: 1, ordered: true });
    // PGT-145d: only the two throttled counters and the update time change.
    expect(first.window_started_at.getTime()).toBe(full.window_started_at.getTime());
    expect(first.updated_at.getTime()).toBeGreaterThanOrEqual(full.updated_at.getTime());
    expect(await cancelCheckout(db.web, credential, newId("ci"))).toBe("RATE_LIMITED");
    expect(await admittedCall(db.web, credential)).toBe("RATE_LIMITED");
    expect(await windowOf(db.admin, credential.owner)).toMatchObject({ window_calls: 30, window_throttled: 3, total_throttled: 3 });
    // Over the limit, a malformed request is still REQUEST_INVALID and is not counted (PGT-130).
    expect((await startCheckout(db.web, credential, PRODUCT, VARIANT, 0)).result).toBe("REQUEST_INVALID");
    expect(await windowOf(db.admin, credential.owner)).toMatchObject({ window_throttled: 3, total_throttled: 3 });

    // PGT-125: exactly one audit row for the window, written by its first throttled call.
    const audit = await auditOf(db.admin, credential.owner);
    expect(audit.map((row) => row.event_type)).toEqual(["OWNER_RATE_LIMITED"]);
    expect(audit[0]).toMatchObject({ actor: "server", session_id: credential.session, owner_id: credential.owner, checkout_intent_id: null, operation_id: null, times_equal: true });
    expect(sortedKeys(audit[0].detail)).toEqual(["limit", "windowSeconds", "windowStartedAt"]);
    expect(audit[0].detail).toMatchObject({ limit: 30, windowSeconds: 60 });
    expect(audit[0].detail.windowStartedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    // The driver keeps milliseconds; the first 23 characters of the text are the same instant to the millisecond.
    expect(`${String(audit[0].detail.windowStartedAt).slice(0, 23)}Z`).toBe(full.window_started_at.toISOString());

    // PGT-127b: another owner has a counter of its own.
    const other = await newCredential(db.admin);
    expect(await admittedCall(db.web, other)).toBe("PRODUCT_NOT_IN_MERCHANT_CATALOG");
    // PGT-127a: a second session of the same owner draws on the same counter.
    const second = await newCredential(db.admin, NOW, NOW, credential.owner);
    expect(await admittedCall(db.web, second)).toBe("RATE_LIMITED");

    // PGT-145b and c: a window that elapsed. NOT_AUTHORIZED leaves the row as it is; an admitted call starts a new one.
    const elapsed = await newCredential(db.admin);
    await db.admin.query(SQL.insertWindow, [elapsed.owner, "-2 minutes", 30, "-2 minutes"]);
    const stored = await windowOf(db.admin, elapsed.owner);
    expect(await cancelCheckout(db.web, elapsed, newId("ci"))).toBe("NOT_AUTHORIZED");
    expect(await windowOf(db.admin, elapsed.owner)).toEqual(stored);
    expect(await admittedCall(db.web, elapsed)).toBe("PRODUCT_NOT_IN_MERCHANT_CATALOG");
    const renewed = await windowOf(db.admin, elapsed.owner);
    expect(renewed).toMatchObject({ window_calls: 1, window_throttled: 0, ordered: true });
    expect(renewed.window_started_at.getTime()).toBeGreaterThan(stored.window_started_at.getTime());
    expect(renewed.updated_at.getTime()).toBe(renewed.window_started_at.getTime());
  });

  it("PGT-124 (b): owner_window_decision decides exact boundaries from explicit times, and a time before the window start belongs to the stored window", async () => {
    const start = "2026-01-01T00:00:00.000000Z";
    const decide = async (calls: number, offset: string) => (await db.admin.query(SQL.windowDecision, [start, calls, offset])).rows[0];
    expect(await decide(5, "59.999999 seconds")).toEqual({ starts_new_window: false, over_limit: false });
    expect(await decide(5, "60 seconds")).toEqual({ starts_new_window: true, over_limit: false });
    expect(await decide(5, "60.000001 seconds")).toEqual({ starts_new_window: true, over_limit: false });
    expect(await decide(29, "0 seconds")).toEqual({ starts_new_window: false, over_limit: false });
    expect(await decide(30, "0 seconds")).toEqual({ starts_new_window: false, over_limit: true });
    expect(await decide(30, "59.999999 seconds")).toEqual({ starts_new_window: false, over_limit: true });
    // At the boundary instant a full window is over: the call starts a new one and is not over the limit.
    expect(await decide(30, "60 seconds")).toEqual({ starts_new_window: true, over_limit: false });
    // Backward clock: a decision time before the stored start stays in the stored window.
    expect(await decide(5, "-10 seconds")).toEqual({ starts_new_window: false, over_limit: false });
    expect(await decide(30, "-1 hour")).toEqual({ starts_new_window: false, over_limit: true });
    // No row: a new window, never over the limit.
    expect((await db.admin.query(SQL.windowDecisionNoRow)).rows[0]).toEqual({ starts_new_window: true, over_limit: false });
  });

  it("PGT-145 (e) to (h): with stored times later than the clock, updated_at never moves backward and the window rule still holds", async () => {
    // No function takes a time, so a backward clock is produced by fixtures whose stored times are in the future.
    // (e) Window start and updated_at in the future, under the limit: the call stays in the stored window.
    const under = await newCredential(db.admin);
    await db.admin.query(SQL.insertWindow, [under.owner, "30 seconds", 5, "40 seconds"]);
    const underBefore = await windowOf(db.admin, under.owner);
    expect(await admittedCall(db.web, under)).toBe("PRODUCT_NOT_IN_MERCHANT_CATALOG");
    const underAfter = await windowOf(db.admin, under.owner);
    expect(underAfter).toMatchObject({ window_calls: 6, window_throttled: 0, total_throttled: 0, ordered: true });
    expect(underAfter.window_started_at.getTime()).toBe(underBefore.window_started_at.getTime());
    expect(underAfter.updated_at.getTime()).toBe(underBefore.updated_at.getTime());

    // (f) The same at the limit: only the two throttled counters change.
    const limited = await newCredential(db.admin);
    await db.admin.query(SQL.insertWindow, [limited.owner, "30 seconds", 30, "40 seconds"]);
    const limitedBefore = await windowOf(db.admin, limited.owner);
    expect(await admittedCall(db.web, limited)).toBe("RATE_LIMITED");
    const limitedAfter = await windowOf(db.admin, limited.owner);
    expect(limitedAfter).toMatchObject({ window_calls: 30, window_throttled: 1, total_throttled: 1, ordered: true });
    expect(limitedAfter.window_started_at.getTime()).toBe(limitedBefore.window_started_at.getTime());
    expect(limitedAfter.updated_at.getTime()).toBe(limitedBefore.updated_at.getTime());

    // (g) Window start long past, updated_at in the future: a new window starts at the call's own reading, and
    // updated_at keeps the stored, greater value.
    const reset = await newCredential(db.admin);
    await db.admin.query(SQL.insertWindow, [reset.owner, "-5 minutes", 30, "40 seconds"]);
    const resetBefore = await windowOf(db.admin, reset.owner);
    const lowerBound = Date.now() - 5_000;
    expect(await admittedCall(db.web, reset)).toBe("PRODUCT_NOT_IN_MERCHANT_CATALOG");
    const resetAfter = await windowOf(db.admin, reset.owner);
    expect(resetAfter).toMatchObject({ window_calls: 1, window_throttled: 0, ordered: true });
    expect(resetAfter.window_started_at.getTime()).toBeGreaterThan(lowerBound);
    expect(resetAfter.window_started_at.getTime()).toBeLessThan(resetBefore.updated_at.getTime());
    expect(resetAfter.updated_at.getTime()).toBe(resetBefore.updated_at.getTime());

    // (h) An intent whose times are in the future: cancel succeeds, updated_at is unchanged, the transition's two
    // times are equal.
    const future = await newCredential(db.admin);
    const fixture = await insertFixtureCheckout(db.admin, future, new Date(Date.now() + 60 * 60 * 1000), false);
    const intentBefore = await intentOf(db.admin, fixture.intent);
    expect(await cancelCheckout(db.web, future, fixture.intent)).toBe("CANCELED");
    const intentAfter = await intentOf(db.admin, fixture.intent);
    expect(intentAfter).toMatchObject({ state: "CANCELED_LOCAL", row_version: 3 });
    expect(intentAfter.updated_at.getTime()).toBe(intentBefore.updated_at.getTime());
    expect((await db.admin.query(SQL.transitionRows, [fixture.intent])).rows.at(-1)).toMatchObject({ event_type: "SHOPPER_CANCELED", times_equal: true });
  });

  it("PGT-138 (database side): checkout_transition accepts exactly T1 to T6 and returns the pointers it was given where an event does not change them", async () => {
    const quote = newId("qt");
    const otherQuote = newId("qt");
    const challenge = newId("cf");
    const successor = newId("ci");
    const decide = async (values: readonly unknown[]) => (await db.admin.query(SQL.transition, [...values])).rows[0];
    const refused = { accepted: false, to_state: null, to_version: null, quote_id: null, confirmation_id: null, superseded_by_intent_id: null };

    // T1 to T6, with what the intent holds afterwards.
    expect(await decide(["DRAFT", 1, "QUOTE_ISSUED", "server", "start_checkout", null, null, null, quote, null, null])).toEqual({
      accepted: true,
      to_state: "QUOTED",
      to_version: 2,
      quote_id: quote,
      confirmation_id: null,
      superseded_by_intent_id: null,
    });
    expect(await decide(["QUOTED", 2, "SHOPPER_CONFIRMED", "shopper", "consume_challenge", quote, null, null, quote, challenge, null])).toEqual({
      accepted: true,
      to_state: "USER_CONFIRMED",
      to_version: 3,
      quote_id: quote,
      confirmation_id: challenge,
      superseded_by_intent_id: null,
    });
    expect(await decide(["QUOTED", 2, "SHOPPER_CANCELED", "shopper", "cancel_checkout", quote, null, null, null, null, null])).toEqual({
      accepted: true,
      to_state: "CANCELED_LOCAL",
      to_version: 3,
      quote_id: quote,
      confirmation_id: null,
      superseded_by_intent_id: null,
    });
    // T4 and T6: the confirmation pointer comes back exactly as it went in.
    expect(await decide(["USER_CONFIRMED", 3, "SHOPPER_CANCELED", "shopper", "cancel_checkout", quote, challenge, null, null, null, null])).toEqual({
      accepted: true,
      to_state: "CANCELED_LOCAL",
      to_version: 4,
      quote_id: quote,
      confirmation_id: challenge,
      superseded_by_intent_id: null,
    });
    expect(await decide(["QUOTED", 7, "SUPERSEDED", "server", "start_checkout", quote, null, null, null, null, successor])).toEqual({
      accepted: true,
      to_state: "SUPERSEDED",
      to_version: 8,
      quote_id: quote,
      confirmation_id: null,
      superseded_by_intent_id: successor,
    });
    expect(await decide(["USER_CONFIRMED", 3, "SUPERSEDED", "server", "start_checkout", quote, challenge, null, null, null, successor])).toEqual({
      accepted: true,
      to_state: "SUPERSEDED",
      to_version: 4,
      quote_id: quote,
      confirmation_id: challenge,
      superseded_by_intent_id: successor,
    });

    // An otherwise valid event that also carries a pointer its type does not use. Specification 19.7a makes
    // acceptance depend on the event, actor, states, entry point, version and the pointer rules it lists for that
    // transition, and says an event that does not change a pointer returns the value it was given. The reducer
    // reads only the payload of the event's own type, and the schema stores none of these values. So the unused
    // pointer neither refuses the event nor reaches the result.
    const stray = newId("qt");
    const strayChallenge = newId("cf");
    const strayIntent = newId("ci");
    const unaffectedCases: Array<[string, readonly unknown[], Record<string, unknown>]> = [
      [
        "T1 carrying a confirmation and a successor",
        ["DRAFT", 1, "QUOTE_ISSUED", "server", "start_checkout", null, null, null, quote, strayChallenge, strayIntent],
        { accepted: true, to_state: "QUOTED", to_version: 2, quote_id: quote, confirmation_id: null, superseded_by_intent_id: null },
      ],
      [
        "T2 carrying a successor",
        ["QUOTED", 2, "SHOPPER_CONFIRMED", "shopper", "consume_challenge", quote, null, null, quote, challenge, strayIntent],
        { accepted: true, to_state: "USER_CONFIRMED", to_version: 3, quote_id: quote, confirmation_id: challenge, superseded_by_intent_id: null },
      ],
      [
        "T3 carrying another quote, a confirmation and a successor",
        ["QUOTED", 2, "SHOPPER_CANCELED", "shopper", "cancel_checkout", quote, null, null, stray, strayChallenge, strayIntent],
        { accepted: true, to_state: "CANCELED_LOCAL", to_version: 3, quote_id: quote, confirmation_id: null, superseded_by_intent_id: null },
      ],
      [
        "T4 carrying another quote, another confirmation and a successor",
        ["USER_CONFIRMED", 3, "SHOPPER_CANCELED", "shopper", "cancel_checkout", quote, challenge, null, stray, strayChallenge, strayIntent],
        { accepted: true, to_state: "CANCELED_LOCAL", to_version: 4, quote_id: quote, confirmation_id: challenge, superseded_by_intent_id: null },
      ],
      [
        "T5 carrying another quote and a confirmation",
        ["QUOTED", 2, "SUPERSEDED", "server", "start_checkout", quote, null, null, stray, strayChallenge, successor],
        { accepted: true, to_state: "SUPERSEDED", to_version: 3, quote_id: quote, confirmation_id: null, superseded_by_intent_id: successor },
      ],
      [
        "T6 carrying another quote and another confirmation",
        ["USER_CONFIRMED", 3, "SUPERSEDED", "server", "start_checkout", quote, challenge, null, stray, strayChallenge, successor],
        { accepted: true, to_state: "SUPERSEDED", to_version: 4, quote_id: quote, confirmation_id: challenge, superseded_by_intent_id: successor },
      ],
    ];
    for (const [label, values, expected] of unaffectedCases) expect(await decide(values), label).toEqual(expected);
    // A pointer the event does use still decides: the same strays do not rescue an event that lacks its own.
    expect(await decide(["QUOTED", 2, "SUPERSEDED", "server", "start_checkout", quote, null, null, stray, strayChallenge, null]), "supersession with strays but no successor").toEqual(refused);
    expect(await decide(["QUOTED", 2, "SHOPPER_CONFIRMED", "shopper", "consume_challenge", quote, null, null, stray, challenge, strayIntent]), "confirmation of another quote").toEqual(refused);

    // Everything else is refused, and a refusal carries nothing.
    const refusedCases: Array<[string, readonly unknown[]]> = [
      ["T1 from version 2", ["DRAFT", 2, "QUOTE_ISSUED", "server", "start_checkout", null, null, null, quote, null, null]],
      ["T1 by the shopper", ["DRAFT", 1, "QUOTE_ISSUED", "shopper", "start_checkout", null, null, null, quote, null, null]],
      ["T1 through another entry point", ["DRAFT", 1, "QUOTE_ISSUED", "server", "cancel_checkout", null, null, null, quote, null, null]],
      ["T1 without a quote", ["DRAFT", 1, "QUOTE_ISSUED", "server", "start_checkout", null, null, null, null, null, null]],
      ["an in-place re-quote, which the reducer accepts", ["QUOTED", 2, "QUOTE_ISSUED", "server", "start_checkout", quote, null, null, otherQuote, null, null]],
      ["T2 with another quote: the quote-match guard", ["QUOTED", 2, "SHOPPER_CONFIRMED", "shopper", "consume_challenge", quote, null, null, otherQuote, challenge, null]],
      ["T2 without a confirmation", ["QUOTED", 2, "SHOPPER_CONFIRMED", "shopper", "consume_challenge", quote, null, null, quote, null, null]],
      ["T2 by the server", ["QUOTED", 2, "SHOPPER_CONFIRMED", "server", "consume_challenge", quote, null, null, quote, challenge, null]],
      ["T2 from USER_CONFIRMED", ["USER_CONFIRMED", 3, "SHOPPER_CONFIRMED", "shopper", "consume_challenge", quote, challenge, null, quote, challenge, null]],
      ["cancel by the server", ["QUOTED", 2, "SHOPPER_CANCELED", "server", "cancel_checkout", quote, null, null, null, null, null]],
      ["cancel through start_checkout", ["QUOTED", 2, "SHOPPER_CANCELED", "shopper", "start_checkout", quote, null, null, null, null, null]],
      ["cancel from version 1", ["QUOTED", 1, "SHOPPER_CANCELED", "shopper", "cancel_checkout", quote, null, null, null, null, null]],
      ["cancel from CANCELED_LOCAL", ["CANCELED_LOCAL", 3, "SHOPPER_CANCELED", "shopper", "cancel_checkout", quote, null, null, null, null, null]],
      ["cancel from SUPERSEDED", ["SUPERSEDED", 3, "SHOPPER_CANCELED", "shopper", "cancel_checkout", quote, null, successor, null, null, null]],
      ["cancel from DRAFT, which the reducer accepts", ["DRAFT", 1, "SHOPPER_CANCELED", "shopper", "cancel_checkout", null, null, null, null, null, null]],
      ["supersession without a successor", ["QUOTED", 2, "SUPERSEDED", "server", "start_checkout", quote, null, null, null, null, null]],
      ["supersession of an intent that has a successor", ["QUOTED", 2, "SUPERSEDED", "server", "start_checkout", quote, null, successor, null, null, newId("ci")]],
      ["supersession by the shopper", ["QUOTED", 2, "SUPERSEDED", "shopper", "start_checkout", quote, null, null, null, null, successor]],
      ["supersession from CANCELED_LOCAL", ["CANCELED_LOCAL", 3, "SUPERSEDED", "server", "start_checkout", quote, null, null, null, null, successor]],
      ["EXPIRED, which no Increment 2 entry point raises", ["QUOTED", 2, "EXPIRED", "timer", "start_checkout", quote, null, null, null, null, null]],
      ["QUOTE_INVALIDATED", ["QUOTED", 2, "QUOTE_INVALIDATED", "server", "start_checkout", quote, null, null, null, null, null]],
      ["a payment event", ["USER_CONFIRMED", 3, "ORDER_CREATE_DISPATCHED", "operation_worker", "start_checkout", quote, challenge, null, null, null, null]],
      ["no event at all", ["QUOTED", 2, null, "server", "start_checkout", quote, null, null, null, null, null]],
    ];
    for (const [label, values] of refusedCases) expect(await decide(values), label).toEqual(refused);
  });

  it("PGT-133: every function refuses any isolation level but READ COMMITTED, in every situation, and changes nothing", async () => {
    const credential = await newCredential(db.admin);
    const empty = await newCredential(db.admin);
    const intentId = (await startCheckout(db.web, credential)).intent_id as string;
    const unknownDigest = hex(32);
    const before = await snapshotOf(db.admin);

    const levels: readonly IsolationKey[] = ["beginRepeatableRead", "beginSerializable", "beginReadUncommitted"];
    const situations: Array<[string, CallKey, readonly unknown[]]> = [
      // The read functions: authorized with rows; authorized with none; unauthorized.
      ["read_checkout, authorized, found", "readCheckout", [KEY_VERSION, credential.digest, intentId]],
      ["read_checkout, authorized, no such intent", "readCheckout", [KEY_VERSION, credential.digest, newId("ci")]],
      ["read_checkout, unauthorized", "readCheckout", [KEY_VERSION, unknownDigest, intentId]],
      ["list_owner_checkouts, authorized, with rows", "listOwnerCheckouts", [KEY_VERSION, credential.digest]],
      ["list_owner_checkouts, authorized, with none", "listOwnerCheckouts", [KEY_VERSION, empty.digest]],
      ["list_owner_checkouts, unauthorized", "listOwnerCheckouts", [KEY_VERSION, unknownDigest]],
      // The mutating functions: with and without a valid credential.
      ["start_checkout, valid credential", "startCheckout", [KEY_VERSION, credential.digest, PRODUCT, VARIANT, 1, null]],
      ["start_checkout, no credential", "startCheckout", [KEY_VERSION, unknownDigest, PRODUCT, VARIANT, 1, null]],
      ["cancel_checkout, valid credential", "cancelCheckout", [KEY_VERSION, credential.digest, intentId]],
      ["cancel_checkout, no credential", "cancelCheckout", [KEY_VERSION, unknownDigest, intentId]],
    ];
    const observed: Array<{ level: string; situation: string; sqlstate: string | null }> = [];
    for (const level of levels) {
      for (const [situation, statement, values] of situations) {
        observed.push({ level, situation, sqlstate: await refusedAtIsolation(db.admin, level, statement, values) });
      }
    }
    // Every case is attempted before anything is asserted, and the whole table is recorded with the run.
    console.info(`Increment 2.1 isolation refusals as observed: ${JSON.stringify(observed)}`);
    expect(await snapshotOf(db.admin)).toEqual(before);
    expect(observed.filter((entry) => entry.sqlstate !== ISOLATION_REFUSED)).toEqual([]);
    expect(observed).toHaveLength(30);

    // At READ COMMITTED the same three read situations return, and return what 19.11 says.
    expect((await readCheckout(db.web, credential, intentId)).result).toBe("OK");
    expect((await readCheckout(db.web, credential, newId("ci"))).result).toBe("NOT_AUTHORIZED");
    expect((await readCheckout(db.web, { ...credential, digest: unknownDigest }, intentId)).result).toBe("NOT_AUTHORIZED");
    expect(await listCheckouts(db.web, credential)).toHaveLength(1);
    expect(await listCheckouts(db.web, empty)).toEqual([]);
    expect(await listCheckouts(db.web, { ...credential, digest: unknownDigest })).toEqual([]);

    // PGT-133 (a): a call inside a transaction that is then rolled back leaves no counter change and no audit row.
    const beforeRolledBack = await snapshotOf(db.admin);
    await db.admin.query(SQL.begin);
    try {
      expect((await db.admin.query(SQL.startCheckout, [KEY_VERSION, credential.digest, PRODUCT, VARIANT, 1, null])).rows[0].result).toBe("STARTED");
    } finally {
      await db.admin.query(SQL.rollback);
    }
    expect(await snapshotOf(db.admin)).toEqual(beforeRolledBack);
  });

  it("PGT-128: when a counter write or an audit write fails, the call raises and nothing it did survives", async () => {
    const allHeld = { window_insert: true, window_calls_update: true, total_throttled_update: true, audit_insert: true };
    expect((await db.admin.query(SQL.definerPrivileges)).rows[0]).toEqual(allHeld);

    // K1: no window row; a call that would be admitted; the row cannot be created.
    const k1 = await newCredential(db.admin);
    // K2: a row under the limit; the admitted increment cannot be written.
    const k2 = await newCredential(db.admin);
    await db.admin.query(SQL.insertWindow, [k2.owner, "0 seconds", 3, "0 seconds"]);
    // K3: a row at the limit; the throttled counters cannot be written.
    const k3 = await newCredential(db.admin);
    await db.admin.query(SQL.insertWindow, [k3.owner, "0 seconds", 30, "0 seconds"]);
    // A1: a row at the limit, nothing throttled yet; the counters are written, then the audit insert fails.
    const a1 = await newCredential(db.admin);
    await db.admin.query(SQL.insertWindow, [a1.owner, "0 seconds", 30, "0 seconds"]);
    // A2: an owner at group capacity; the capacity-refusal audit insert fails.
    const a2 = await newCredential(db.admin);
    for (let index = 0; index < 10; index += 1) await insertFixtureCheckout(db.admin, a2, minutesAgo(1), false);
    // A3: an ordinary new checkout; the QUOTE_ISSUED audit insert fails.
    const a3 = await newCredential(db.admin);

    const startValues = (credential: Credential): unknown[] => [KEY_VERSION, credential.digest, PRODUCT, VARIANT, 1, null];
    const cases: Array<[string, Revocation, "startCheckout" | "cancelCheckout", readonly unknown[]]> = [
      ["K1", "K1", "startCheckout", startValues(k1)],
      ["K2", "K2", "startCheckout", startValues(k2)],
      ["K3", "K3", "startCheckout", startValues(k3)],
      ["A1", "A", "cancelCheckout", [KEY_VERSION, a1.digest, newId("ci")]],
      ["A2", "A", "startCheckout", startValues(a2)],
      ["A3", "A", "startCheckout", startValues(a3)],
    ];
    const before = await snapshotOf(db.admin);
    const observed: Array<{ label: string; raised: string | null; afterwards: string | null }> = [];
    for (const [label, revocation, statement, values] of cases) {
      observed.push({ label, ...(await withRevokedPrivilege(db.admin, revocation, statement, values)) });
    }
    console.info(`PGT-128 as observed: ${JSON.stringify(observed)}`);
    // Each call itself raised a privilege error, and the transaction it ran in was aborted by it.
    expect(observed.map((entry) => `${entry.label}:${entry.raised}`)).toEqual(cases.map(([label]) => `${label}:${INSUFFICIENT_PRIVILEGE}`));
    expect(observed.map((entry) => `${entry.label}:${entry.afterwards}`)).toEqual(cases.map(([label]) => `${label}:${IN_FAILED_TRANSACTION}`));
    // After the rollbacks: every privilege is back, and not one row changed. In A1 the counters had already been
    // written inside the call; they did not survive the failed audit write.
    expect((await db.admin.query(SQL.definerPrivileges)).rows[0]).toEqual(allHeld);
    expect(await snapshotOf(db.admin)).toEqual(before);

    // Control: without a revocation the same calls do what they should.
    expect((await startCheckout(db.web, k1)).result).toBe("STARTED");
    expect(await admittedCall(db.web, k3)).toBe("RATE_LIMITED");
    expect((await startCheckout(db.web, a2)).result).toBe("AT_PURCHASE_CAPACITY");
  });

  it("PGT-112 (c): a deferred check that fails for the function's own writes is raised by the function call itself, with its constraint name", async () => {
    const CHECK_VIOLATION = "23514";
    const nothingLeft = { triggers: 0, functions: 0 };
    // S1 and S2: an ordinary new checkout. C1: the cancellation of a QUOTED checkout.
    const s1 = await newCredential(db.admin);
    const s2 = await newCredential(db.admin);
    const c1 = await newCredential(db.admin);
    const quoted = (await startCheckout(db.web, c1)).intent_id as string;
    const cases: Array<[string, SuppressedTable, "startCheckout" | "cancelCheckout", readonly unknown[], string]> = [
      // The item is suppressed: the quote's own deferred check finds no item.
      ["S1", "quote_items", "startCheckout", [KEY_VERSION, s1.digest, PRODUCT, VARIANT, 1, null], "quotes_item_check"],
      // The first transition is suppressed: the intent's deferred history check finds none.
      ["S2", "checkout_transitions", "startCheckout", [KEY_VERSION, s2.digest, PRODUCT, VARIANT, 1, null], "checkout_intents_history_check"],
      // The cancelling transition is suppressed: the intent's deferred history check finds one too few.
      ["C1", "checkout_transitions", "cancelCheckout", [KEY_VERSION, c1.digest, quoted], "checkout_intents_history_check"],
    ];
    expect((await db.admin.query(SQL.suppressionFixtures)).rows[0]).toEqual(nothingLeft);
    const before = await snapshotOf(db.admin);

    // Every case is attempted before anything is asserted, and what each met is recorded with the run.
    const observed: Array<{ label: string } & SuppressedOutcome> = [];
    for (const [label, suppressed, statement, values] of cases) observed.push({ label, ...(await withSuppressedInsert(db.admin, suppressed, statement, values)) });
    console.info(`PGT-112(c) as observed: ${JSON.stringify(observed)}`);

    // After the rollbacks: the trigger and its function do not exist, and not one row of any table changed. The
    // counter, the audit table and the QUOTED checkout of C1 are as they were.
    expect((await db.admin.query(SQL.suppressionFixtures)).rows[0]).toEqual(nothingLeft);
    expect(await snapshotOf(db.admin)).toEqual(before);
    expect(await intentOf(db.admin, quoted)).toMatchObject({ state: "QUOTED", row_version: 2 });

    // Inside each transaction the fixtures were there: one function and one trigger.
    expect(observed.map((entry) => entry.fixturesInside)).toEqual(cases.map(() => ({ triggers: 1, functions: 1 })));
    // The call itself must raise. A call that returns STARTED or CANCELED fails this test, whatever a later COMMIT
    // would have done: the forcing would then not have happened inside the call.
    expect(observed.map((entry) => `${entry.label}:${entry.returned}`)).toEqual(cases.map(([label]) => `${label}:null`));
    // It raises the deferred check queued by the parent row, by name, as a check violation.
    expect(observed.map((entry) => `${entry.label}:${entry.constraint}`)).toEqual(cases.map(([label, , , , constraint]) => `${label}:${constraint}`));
    expect(observed.map((entry) => `${entry.label}:${entry.sqlstate}`)).toEqual(cases.map(([label]) => `${label}:${CHECK_VIOLATION}`));
    // And the failure aborted the transaction the call ran in.
    expect(observed.map((entry) => `${entry.label}:${entry.afterwards}`)).toEqual(cases.map(([label]) => `${label}:${IN_FAILED_TRANSACTION}`));

    // Control: without the trigger, the same three calls succeed, so the failures above were the trigger's doing.
    // (That the same invalid state, made by direct writes that force nothing, is refused only at COMMIT is the
    // control of PGT-112(b) and PGT-146 in checkout-schema.test.ts.)
    expect((await startCheckout(db.web, s1)).result).toBe("STARTED");
    expect((await startCheckout(db.web, s2)).result).toBe("STARTED");
    expect(await cancelCheckout(db.web, c1, quoted)).toBe("CANCELED");
  });

  it("PGT-103, PGT-104 and PGT-152 (privilege part): as the function owner the catalog can be read and nothing else, an owner row can be locked and never changed, and a window can never change owner", async () => {
    // PGT-103. SELECT succeeds on the three catalog tables.
    expect(await asFunctionOwner(db.admin, "countMerchants", [])).toBeNull();
    expect(await asFunctionOwner(db.admin, "countProducts", [])).toBeNull();
    expect(await asFunctionOwner(db.admin, "countVariants", [])).toBeNull();
    // A row lock of any strength, an UPDATE, an INSERT and a DELETE are each refused for want of privilege.
    const refusedForFunctionOwner: Array<[FunctionOwnerKey, readonly unknown[]]> = [
      ["lockMerchantForUpdate", [MERCHANT]],
      ["lockProductForUpdate", [PRODUCT]],
      ["lockVariantForUpdate", [VARIANT]],
      ["lockVariantForShare", [VARIANT]],
      ["lockVariantForKeyShare", [VARIANT]],
      ["touchMerchant", [MERCHANT]],
      ["touchProduct", [PRODUCT]],
      ["touchVariant", [VARIANT]],
      ["addMerchant", ["dmm_anothermerchant"]],
      ["removeMerchant", [MERCHANT]],
      ["removeProduct", [PRODUCT]],
      ["removeVariant", [VARIANT]],
    ];
    const observed: Array<{ statement: string; sqlstate: string | null }> = [];
    for (const [statement, values] of refusedForFunctionOwner) observed.push({ statement, sqlstate: await asFunctionOwner(db.admin, statement, values) });
    expect(observed.filter((entry) => entry.sqlstate !== INSUFFICIENT_PRIVILEGE)).toEqual([]);
    expect(observed).toHaveLength(12);
    // The catalog is as it was.
    expect((await db.admin.query(SQL.variantCatalog, [VARIANT])).rows).toHaveLength(1);

    // PGT-104. The locking read of an owner row succeeds for the function owner; every UPDATE of the row is
    // rejected by the table's trigger, not by a missing privilege.
    const credential = await newCredential(db.admin);
    const ownerRow = await ownerRowAsFunctionOwner(db.admin, credential.owner);
    expect(ownerRow.locked).toBe(1);
    expect(ownerRow.update).toBe("23001");
    expect(ownerRow.message).toBe("UPDATE is not permitted on checkout_owners");

    // PGT-152, the part that needed the functions migration: the function owner cannot change the owner of a
    // request window (the column is not granted), and cannot delete a window or an intent (DELETE is not granted).
    const other = await newCredential(db.admin);
    expect(await admittedCall(db.web, credential)).toBe("PRODUCT_NOT_IN_MERCHANT_CATALOG");
    const fixture = await insertFixtureCheckout(db.admin, credential, minutesAgo(1), false);
    const before = await snapshotOf(db.admin);
    expect(await asFunctionOwner(db.admin, "moveWindowOwner", [credential.owner, other.owner])).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await asFunctionOwner(db.admin, "removeWindow", [credential.owner])).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await asFunctionOwner(db.admin, "removeIntent", [fixture.intent])).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await snapshotOf(db.admin)).toEqual(before);
  });

  it("PGT-81b and PGT-121: resolved history is not counted and stays readable; an expired quote still counts", async () => {
    // PGT-81b. Eleven resolved groups (each canceled) and nine unresolved: a new group is permitted, the next is not.
    const credential = await newCredential(db.admin);
    const resolved: FixtureCheckout[] = [];
    for (let index = 0; index < 11; index += 1) {
      const fixture = await insertFixtureCheckout(db.admin, credential, minutesAgo(2), false);
      await cancelFixtureDirectly(db.admin, credential, fixture);
      resolved.push(fixture);
    }
    for (let index = 0; index < 9; index += 1) await insertFixtureCheckout(db.admin, credential, minutesAgo(1), false);
    expect(await countsOf(db.admin, credential.owner)).toMatchObject({ groups: 20, intents: 20 });
    const tenth = await startCheckout(db.web, credential);
    expect(tenth.result).toBe("STARTED");
    expect((await startCheckout(db.web, credential)).result).toBe("AT_PURCHASE_CAPACITY");
    // Nothing was deleted, recycled or reclassified to make room: the history is stored and readable.
    expect(await countsOf(db.admin, credential.owner)).toMatchObject({ groups: 21, intents: 21 });
    expect(await listCheckouts(db.web, credential)).toHaveLength(21);
    for (const fixture of resolved) expect((await intentOf(db.admin, fixture.intent)).state).toBe("CANCELED_LOCAL");
    expect(await readCheckout(db.web, credential, resolved.at(0)?.intent ?? null)).toMatchObject({ result: "OK", stored_state: "CANCELED_LOCAL" });
    // Canceling an unresolved one resolves its group, and one more is permitted: not a lifetime limit.
    expect(await cancelCheckout(db.web, credential, tenth.intent_id as string)).toBe("CANCELED");
    expect((await startCheckout(db.web, credential)).result).toBe("STARTED");

    // PGT-121. Ten groups whose quotes have all expired are still unresolved: stored as QUOTED, they count.
    const expired = await newCredential(db.admin);
    for (let index = 0; index < 10; index += 1) await insertFixtureCheckout(db.admin, expired, minutesAgo(20 + index), false);
    expect((await listCheckouts(db.web, expired)).map((row) => row.effective_status)).toEqual(Array.from({ length: 10 }, () => "QUOTE_EXPIRED"));
    const refused = await startCheckout(db.web, expired);
    expect(refused.result).toBe("AT_PURCHASE_CAPACITY");
    expect(await countsOf(db.admin, expired.owner)).toEqual({ groups: 10, intents: 10, quotes: 10, audits: 11 });
    expect((await auditOf(db.admin, expired.owner)).at(-1)).toMatchObject({ event_type: "CHECKOUT_REFUSED_AT_CAPACITY", owner_id: expired.owner });
  });

  it("PGT-134: every outcome changes exactly the tables 19.10 permits, from a row-absent and from a row-present request window", async () => {
    const NONE: string[] = [];
    const COUNTER = ["owner_request_windows"];
    const COUNTER_AND_AUDIT = ["audit_events", "owner_request_windows"];
    const CANCELLATION = ["audit_events", "checkout_intents", "checkout_transitions", "owner_request_windows"];
    const REPLACEMENT = ["audit_events", "checkout_intents", "checkout_transitions", "owner_request_windows", "quote_items", "quotes"];
    const NEW_CHECKOUT = ["audit_events", "checkout_intents", "checkout_transitions", "owner_request_windows", "purchase_groups", "quote_items", "quotes"];

    /** Runs one call and reports its result, the tables whose row count or content changed, and the audit rows it added. */
    const observe = async (credential: Credential, run: () => Promise<string>): Promise<{ result: string; changed: string[]; audited: string[] }> => {
      const before = await snapshotOf(db.admin);
      const auditBefore = (await auditOf(db.admin, credential.owner)).length;
      const result = await run();
      const after = new Map<string, unknown>(Object.entries(await snapshotOf(db.admin)));
      const changed = Object.entries(before)
        .filter(([table, value]) => after.get(table) !== value)
        .map(([table]) => table)
        .sort();
      const audited = (await auditOf(db.admin, credential.owner)).slice(auditBefore).map((row) => String(row.event_type));
      return { result, changed, audited };
    };

    const observed: Array<{ window: string; outcome: string; result: string; changed: string[]; audited: string[] }> = [];
    const expected: Array<{ window: string; outcome: string; result: string; changed: string[]; audited: string[] }> = [];
    for (const windowState of ["absent", "present"]) {
      /** A new owner whose request window is absent, or present and under the limit. Fixtures never create one. */
      const owner = async (): Promise<Credential> => {
        const credential = await newCredential(db.admin);
        if (windowState === "present") await db.admin.query(SQL.insertWindow, [credential.owner, "0 seconds", 3, "0 seconds"]);
        return credential;
      };
      const record = async (outcome: string, credential: Credential, run: () => Promise<string>, result: string, changed: string[], audited: string[]): Promise<void> => {
        observed.push({ window: windowState, outcome, ...(await observe(credential, run)) });
        expected.push({ window: windowState, outcome, result, changed, audited });
      };

      // NOT_AUTHORIZED, by credential and by resource; REQUEST_INVALID: nothing at all.
      const plain = await owner();
      await record("NOT_AUTHORIZED (credential)", plain, async () => (await startCheckout(db.web, { ...plain, digest: hex(32) })).result, "NOT_AUTHORIZED", NONE, []);
      await record("NOT_AUTHORIZED (missing intent)", plain, () => cancelCheckout(db.web, plain, newId("ci")), "NOT_AUTHORIZED", NONE, []);
      await record("REQUEST_INVALID", plain, async () => (await startCheckout(db.web, plain, PRODUCT, VARIANT, 0)).result, "REQUEST_INVALID", NONE, []);

      // Catalog refusal: the admitted-call counter only.
      const catalog = await owner();
      await record("PRODUCT_NOT_IN_MERCHANT_CATALOG", catalog, () => admittedCall(db.web, catalog), "PRODUCT_NOT_IN_MERCHANT_CATALOG", COUNTER, []);

      // Success: a new checkout; a cancellation; a replacement.
      const starter = await owner();
      await record("STARTED (new)", starter, async () => (await startCheckout(db.web, starter)).result, "STARTED", NEW_CHECKOUT, ["QUOTE_ISSUED"]);
      const canceler = await owner();
      const toCancel = await insertFixtureCheckout(db.admin, canceler, minutesAgo(1), false);
      await record("CANCELED", canceler, () => cancelCheckout(db.web, canceler, toCancel.intent), "CANCELED", CANCELLATION, ["CHECKOUT_CANCELED"]);
      const replacer = await owner();
      const toReplace = await insertFixtureCheckout(db.admin, replacer, minutesAgo(1), false);
      await record("STARTED (replacement)", replacer, async () => (await startCheckout(db.web, replacer, PRODUCT, VARIANT, 1, toReplace.intent)).result, "STARTED", REPLACEMENT, [
        "QUOTE_ISSUED",
        "CHECKOUT_SUPERSEDED",
      ]);

      // Refusals on a terminal checkout: the counter only.
      const terminal = await owner();
      const ended = await insertFixtureCheckout(db.admin, terminal, minutesAgo(1), false);
      await cancelFixtureDirectly(db.admin, terminal, ended);
      await record("NOT_CANCELABLE", terminal, () => cancelCheckout(db.web, terminal, ended.intent), "NOT_CANCELABLE", COUNTER, []);
      const stale = await owner();
      const endedToo = await insertFixtureCheckout(db.admin, stale, minutesAgo(1), false);
      await cancelFixtureDirectly(db.admin, stale, endedToo);
      await record("REPLACEMENT_NOT_ALLOWED", stale, async () => (await startCheckout(db.web, stale, PRODUCT, VARIANT, 1, endedToo.intent)).result, "REPLACEMENT_NOT_ALLOWED", COUNTER, []);

      // Capacity refusals: the counter and one audit row.
      const full = await owner();
      for (let index = 0; index < 10; index += 1) await insertFixtureCheckout(db.admin, full, minutesAgo(1), false);
      await record("AT_PURCHASE_CAPACITY", full, async () => (await startCheckout(db.web, full)).result, "AT_PURCHASE_CAPACITY", COUNTER_AND_AUDIT, ["CHECKOUT_REFUSED_AT_CAPACITY"]);
      const chained = await owner();
      const chain = await insertFixtureChain(db.admin, chained, 10);
      await record("GROUP_INTENT_LIMIT", chained, async () => (await startCheckout(db.web, chained, PRODUCT, VARIANT, 1, chain.last)).result, "GROUP_INTENT_LIMIT", COUNTER_AND_AUDIT, [
        "CHECKOUT_REFUSED_AT_CAPACITY",
      ]);
    }
    // RATE_LIMITED can only follow admitted calls, so it has no row-absent state: the first throttled call of a
    // window changes the counters and writes one audit row; a later one changes the counters only.
    const limited = await newCredential(db.admin);
    await db.admin.query(SQL.insertWindow, [limited.owner, "0 seconds", 30, "0 seconds"]);
    observed.push({ window: "present", outcome: "RATE_LIMITED (first)", ...(await observe(limited, () => admittedCall(db.web, limited))) });
    expected.push({ window: "present", outcome: "RATE_LIMITED (first)", result: "RATE_LIMITED", changed: COUNTER_AND_AUDIT, audited: ["OWNER_RATE_LIMITED"] });
    observed.push({ window: "present", outcome: "RATE_LIMITED (later)", ...(await observe(limited, () => cancelCheckout(db.web, limited, newId("ci")))) });
    expected.push({ window: "present", outcome: "RATE_LIMITED (later)", result: "RATE_LIMITED", changed: COUNTER, audited: [] });

    // Every outcome is attempted before anything is asserted, and the whole matrix is recorded with the run.
    console.info(`PGT-134 as observed: ${JSON.stringify(observed)}`);
    expect(observed).toEqual(expected);
    // Sessions and challenges are in the snapshot and are named by no outcome: no call touched either.
    expect(observed.flatMap((entry) => entry.changed).filter((table) => table === "shopper_sessions" || table === "confirmation_challenges")).toEqual([]);
  });

  it("PGT-140 (limit): an owner with more than a hundred checkouts is shown the newest hundred", async () => {
    // 110 checkouts in a state the functions can reach: eleven purchase groups of ten intents each (the limit per
    // group), nine superseded and one live. The live intent of the ten newer groups is then canceled, so ten groups
    // are resolved and one is unresolved: never more than ten unresolved at once, never more than ten per group.
    const credential = await newCredential(db.admin);
    const base = Date.now() - 60 * 1000;
    const chains: Array<{ group: string; last: string; intents: string[] }> = [];
    for (let index = 0; index < 11; index += 1) chains.push(await insertFixtureChain(db.admin, credential, 10, new Date(base - index * 60 * 1000)));
    for (const chain of chains.slice(0, 10)) await cancelFixtureDirectly(db.admin, credential, { intent: chain.last, quote: "", group: chain.group, challenge: null });
    expect(await countsOf(db.admin, credential.owner)).toMatchObject({ groups: 11, intents: 110 });

    // The order of 19.11: newest first by creation time, then by intent id, descending. The ten intents of a chain
    // share one creation time, so the second key decides among them.
    const expected = chains.slice(0, 10).flatMap((chain) => [...chain.intents].sort().reverse());
    const listed = await listCheckouts(db.web, credential);
    expect(listed).toHaveLength(100);
    expect(listed.map((row) => row.intent_id)).toEqual(expected);
    // The ten left out are the oldest group, whole; they are still stored and still readable one by one.
    const omitted = chains.at(10)?.intents ?? [];
    expect(omitted).toHaveLength(10);
    expect(listed.map((row) => row.intent_id).filter((id) => omitted.includes(id))).toEqual([]);
    expect(await readCheckout(db.web, credential, chains.at(10)?.last ?? null)).toMatchObject({ result: "OK", stored_state: "QUOTED" });
    // Each listed row is one whole state.
    expect([...new Set(listed.map((row) => `${row.stored_state}:${row.effective_status}`))].sort()).toEqual(["CANCELED_LOCAL:CANCELED_LOCAL", "SUPERSEDED:SUPERSEDED"]);
    // And the owner, with one unresolved group, can still start a checkout: history is not a limit.
    expect((await startCheckout(db.web, credential)).result).toBe("STARTED");
  });

  it("PGT-153: when the product and the variant carry different revisions, the quote and its digest follow the variant", async () => {
    const original = (await db.admin.query(SQL.variantCatalog, [VARIANT])).rows[0];
    const variantRevision = original.variant_revision + 3;
    const productRevision = original.product_revision + 8;
    await db.admin.query(SQL.setVariantRevision, [VARIANT, variantRevision]);
    await db.admin.query(SQL.setProductRevision, [PRODUCT, productRevision]);
    try {
      const credential = await newCredential(db.admin);
      const started = await startCheckout(db.web, credential);
      expect(started.result).toBe("STARTED");
      const intentId = started.intent_id as string;
      const quote = (await db.admin.query(SQL.quoteRow, [intentId])).rows[0];
      expect(quote.catalog_revision).toBe(variantRevision);
      expect(quote.catalog_revision).not.toBe(productRevision);
      expect((await readCheckout(db.web, credential, intentId)).catalog_revision).toBe(variantRevision);
      // The stored digest is SAQD-1 over the stored fields, the variant's revision among them.
      const digests = (await db.admin.query(SQL.saqdOfStoredQuote, [intentId])).rows[0];
      expect(digests.computed).toBe(digests.stored);
    } finally {
      await db.admin.query(SQL.setVariantRevision, [VARIANT, original.variant_revision]);
      await db.admin.query(SQL.setProductRevision, [PRODUCT, original.product_revision]);
    }
  });

  it("PGT-127 (c) and PGT-132 (credential elements): a rotated session keeps its owner's counter, and a credential that is wrong in any one element is refused", async () => {
    const credential = await newCredential(db.admin);
    for (let index = 1; index <= 20; index += 1) expect(await admittedCall(db.web, credential), `call ${index}`).toBe("PRODUCT_NOT_IN_MERCHANT_CATALOG");
    const beforeRotation = await windowOf(db.admin, credential.owner);
    expect(beforeRotation).toMatchObject({ window_calls: 20, window_throttled: 0 });

    // The rotation, written directly in the shape the session trigger accepts: a new digest for the same session.
    const rotated: Credential = { ...credential, digest: hex(32) };
    await db.admin.query(SQL.rotateSessionDirectly, [credential.session, rotated.digest]);
    // PGT-127c: the counter stays at 20. The owner did not change, so neither did its window.
    expect(await windowOf(db.admin, credential.owner)).toEqual(beforeRotation);
    // The token digest must equal the presented one: the old digest is refused and counts nothing.
    expect(await admittedCall(db.web, credential)).toBe("NOT_AUTHORIZED");
    expect(await windowOf(db.admin, credential.owner)).toEqual(beforeRotation);
    // The new credential continues the same window.
    expect(await admittedCall(db.web, rotated)).toBe("PRODUCT_NOT_IN_MERCHANT_CATALOG");
    expect((await windowOf(db.admin, credential.owner)).window_calls).toBe(21);

    // The key version must equal the presented one: the right digest under another version is refused.
    const wrongVersion = (await db.web.query(SQL.startCheckout, [KEY_VERSION + 1, rotated.digest, UNKNOWN_PRODUCT, UNKNOWN_VARIANT, 1, null])).rows[0];
    expect(wrongVersion.result).toBe("NOT_AUTHORIZED");
    expect((await db.web.query(SQL.readCheckout, [KEY_VERSION + 1, rotated.digest, newId("ci")])).rows[0].result).toBe("NOT_AUTHORIZED");
    expect((await db.web.query(SQL.listOwnerCheckouts, [KEY_VERSION + 1, rotated.digest])).rows).toEqual([]);
    expect((await windowOf(db.admin, credential.owner)).window_calls).toBe(21);
    // Revocation, idle expiry and absolute expiry are the dead sessions of the PGT-08 test above; the key status
    // and the cases in which a revocation or a rotation overlaps a call are in checkout-concurrency.test.ts.

    // PGT-127d: a new session of a new owner starts a counter of its own, whatever the first owner's stands at.
    const newcomer = await newCredential(db.admin);
    expect(await windowOf(db.admin, newcomer.owner)).toBeNull();
    expect(await admittedCall(db.web, newcomer)).toBe("PRODUCT_NOT_IN_MERCHANT_CATALOG");
    expect(await windowOf(db.admin, newcomer.owner)).toMatchObject({ window_calls: 1 });
    expect((await windowOf(db.admin, credential.owner)).window_calls).toBe(21);

    // PGT-127d, directly: a session admitted through the Increment 1 entry point receives an owner of its own, and
    // that owner a counter of its own.
    const admittedSession = newId("ses");
    const admittedDigest = hex(32);
    expect((await db.web.query(SESSION_STATEMENTS.admitSession, [admittedSession, KEY_VERSION, admittedDigest])).rows[0].result).toBe("ADMITTED");
    const admittedRow = (await db.admin.query(SQL.sessionByDigest, [admittedDigest])).rows;
    expect(admittedRow).toHaveLength(1);
    expect(admittedRow[0].id).toBe(admittedSession);
    expect(admittedRow[0].owner_id).toMatch(/^own_[0-9a-f]{32}$/);
    expect([credential.owner, newcomer.owner]).not.toContain(admittedRow[0].owner_id);
    const admitted: Credential = { owner: admittedRow[0].owner_id, session: admittedSession, digest: admittedDigest };
    expect(await windowOf(db.admin, admitted.owner)).toBeNull();
    expect(await admittedCall(db.web, admitted)).toBe("PRODUCT_NOT_IN_MERCHANT_CATALOG");
    expect(await windowOf(db.admin, admitted.owner)).toMatchObject({ window_calls: 1, window_throttled: 0 });
    expect((await startCheckout(db.web, admitted)).result).toBe("STARTED");
    // The first owner's counter did not move.
    expect((await windowOf(db.admin, credential.owner)).window_calls).toBe(21);
  });

  it("PGT-124 (a): thirty calls at the end of one window and thirty at the start of the next are all admitted, and refused calls in between consume none", async () => {
    // The window is placed three seconds from its boundary. The first thirty calls must be observed complete while
    // database time is still before the boundary; otherwise that attempt is abandoned and a new owner is set up.
    let established: { credential: Credential; start: Date } | null = null;
    for (let attempt = 1; attempt <= 3 && established === null; attempt += 1) {
      const credential = await newCredential(db.admin);
      await db.admin.query(SQL.insertWindow, [credential.owner, "-57 seconds", 0, "-57 seconds"]);
      const before = await windowOf(db.admin, credential.owner);
      const firstHalf = await Promise.all(Array.from({ length: 15 }, () => admittedCall(db.web, credential)));
      // Calls that end NOT_AUTHORIZED or REQUEST_INVALID, in between: they consume none of the thirty.
      for (let index = 0; index < 5; index += 1) expect(await cancelCheckout(db.web, credential, newId("ci"))).toBe("NOT_AUTHORIZED");
      expect((await startCheckout(db.web, credential, PRODUCT, VARIANT, 0)).result).toBe("REQUEST_INVALID");
      const secondHalf = await Promise.all(Array.from({ length: 15 }, () => admittedCall(db.web, credential)));
      const stillBefore = (await db.admin.query(SQL.windowMargin, [credential.owner])).rows[0].passed === false;
      const after = await windowOf(db.admin, credential.owner);
      if (stillBefore && after.window_started_at.getTime() === before.window_started_at.getTime()) {
        expect([...firstHalf, ...secondHalf]).toEqual(Array.from({ length: 30 }, () => "PRODUCT_NOT_IN_MERCHANT_CATALOG"));
        expect(after).toMatchObject({ window_calls: 30, window_throttled: 0, total_throttled: 0 });
        established = { credential, start: before.window_started_at };
      }
    }
    if (established === null) throw new Error("thirty calls did not complete before the window boundary in three attempts");
    const { credential, start } = established;

    // Database time is observed reaching the boundary. Then thirty more, at once.
    let reached = false;
    for (let poll = 0; poll < 1200 && !reached; poll += 1) {
      reached = (await db.admin.query(SQL.windowMargin, [credential.owner])).rows[0].passed === true;
      if (!reached) await db.admin.query(SQL.shortSleep);
    }
    expect(reached).toBe(true);
    const burst = await Promise.all(Array.from({ length: 30 }, () => admittedCall(db.web, credential)));
    // Sixty admitted within a few seconds, none throttled: the limit is per window, not per sliding minute.
    expect(burst).toEqual(Array.from({ length: 30 }, () => "PRODUCT_NOT_IN_MERCHANT_CATALOG"));
    const renewed = await windowOf(db.admin, credential.owner);
    expect(renewed).toMatchObject({ window_calls: 30, window_throttled: 0, total_throttled: 0, ordered: true });
    expect(renewed.window_started_at.getTime()).toBeGreaterThanOrEqual(start.getTime() + 60_000);
    // The sixty-first is over the new window's limit.
    expect(await admittedCall(db.web, credential)).toBe("RATE_LIMITED");
    expect((await auditOf(db.admin, credential.owner)).map((row) => row.event_type)).toEqual(["OWNER_RATE_LIMITED"]);
  });

  it("PGT-125: a hundred over-limit calls are all counted and audited once per window, from a missing row and from an existing row", async () => {
    const bystander = await newCredential(db.admin);
    const limited = Array.from({ length: 100 }, () => "RATE_LIMITED");

    // From a missing row: the thirty admitted calls create and fill the window.
    const missing = await newCredential(db.admin);
    expect(await windowOf(db.admin, missing.owner)).toBeNull();
    expect(await Promise.all(Array.from({ length: 30 }, () => admittedCall(db.web, missing)))).toEqual(Array.from({ length: 30 }, () => "PRODUCT_NOT_IN_MERCHANT_CATALOG"));
    expect(await Promise.all(Array.from({ length: 100 }, () => admittedCall(db.web, missing)))).toEqual(limited);
    const firstWindow = await windowOf(db.admin, missing.owner);
    expect(firstWindow).toMatchObject({ window_calls: 30, window_throttled: 100, total_throttled: 100, ordered: true });
    const firstAudit = await auditOf(db.admin, missing.owner);
    expect(firstAudit.map((row) => `${row.event_type}:${row.owner_id}`)).toEqual([`OWNER_RATE_LIMITED:${missing.owner}`]);

    // The next window. No function takes a time, so the test owner moves the stored window 61 seconds into the past
    // (a fixture write under the owner lock, P6); the owner's next call then belongs to a new window.
    await db.admin.query(SQL.begin);
    try {
      await db.admin.query(SQL.lockOwner, [missing.owner]);
      await db.admin.query(SQL.backdateWindow, [missing.owner]);
      await db.admin.query(SQL.commit);
    } catch (error) {
      await db.admin.query(SQL.rollback);
      throw error;
    }
    expect(await Promise.all(Array.from({ length: 30 }, () => admittedCall(db.web, missing)))).toEqual(Array.from({ length: 30 }, () => "PRODUCT_NOT_IN_MERCHANT_CATALOG"));
    // The window counter starts again; the total never does. No new audit row yet: nothing was throttled.
    expect(await windowOf(db.admin, missing.owner)).toMatchObject({ window_calls: 30, window_throttled: 0, total_throttled: 100 });
    expect(await auditOf(db.admin, missing.owner)).toHaveLength(1);
    // Exactly one more audit row, written by the first over-limit call of the new window, and none by the later ones.
    expect(await admittedCall(db.web, missing)).toBe("RATE_LIMITED");
    expect(await auditOf(db.admin, missing.owner)).toHaveLength(2);
    expect(await Promise.all(Array.from({ length: 9 }, () => admittedCall(db.web, missing)))).toEqual(Array.from({ length: 9 }, () => "RATE_LIMITED"));
    expect(await windowOf(db.admin, missing.owner)).toMatchObject({ window_calls: 30, window_throttled: 10, total_throttled: 110 });
    const secondAudit = await auditOf(db.admin, missing.owner);
    expect(secondAudit.map((row) => `${row.event_type}:${row.owner_id}`)).toEqual([`OWNER_RATE_LIMITED:${missing.owner}`, `OWNER_RATE_LIMITED:${missing.owner}`]);
    expect(new Set(secondAudit.map((row) => row.event_id)).size).toBe(2);
    // Each row names the window it was written in.
    expect(secondAudit.at(0)?.detail.windowStartedAt).not.toBe(secondAudit.at(1)?.detail.windowStartedAt);

    // From an existing row: a window already at the limit, written as a fixture.
    const existing = await newCredential(db.admin);
    await db.admin.query(SQL.insertWindow, [existing.owner, "0 seconds", 30, "0 seconds"]);
    expect(await Promise.all(Array.from({ length: 100 }, () => admittedCall(db.web, existing)))).toEqual(limited);
    expect(await windowOf(db.admin, existing.owner)).toMatchObject({ window_calls: 30, window_throttled: 100, total_throttled: 100 });
    expect((await auditOf(db.admin, existing.owner)).map((row) => `${row.event_type}:${row.owner_id}`)).toEqual([`OWNER_RATE_LIMITED:${existing.owner}`]);

    // None for any other owner.
    expect(await auditOf(db.admin, bystander.owner)).toEqual([]);
    expect(await windowOf(db.admin, bystander.owner)).toBeNull();
  });

  it("PGT-130 and PGT-131: REQUEST_INVALID is returned before any lock, and another owner's intent is never locked, under the limit and over it", async () => {
    const credential = await newCredential(db.admin);
    const other = await newCredential(db.admin);
    const theirs = (await startCheckout(db.web, other)).intent_id as string;
    expect((await startCheckout(db.web, credential)).result).toBe("STARTED");
    const waiters = async (): Promise<number> => (await db.admin.query(SQL.lockWaiters)).rows[0].n;

    // PGT-130. The test owner holds the caller's owner row. A malformed request returns at once: it needed no lock.
    // (A call that needed the owner row would wait here and fail on the lock timeout.)
    const before = await snapshotOf(db.admin);
    await db.admin.query(SQL.begin);
    try {
      await db.admin.query(SQL.lockOwner, [credential.owner]);
      expect((await startCheckout(db.web, credential, PRODUCT, VARIANT, 0)).result).toBe("REQUEST_INVALID");
      expect((await db.web.query(SQL.cancelCheckout, [KEY_VERSION, credential.digest, "ci_short"])).rows).toEqual([{ result: "REQUEST_INVALID" }]);
      // Without a session that appears live, the same malformed requests are NOT_AUTHORIZED, also before any lock.
      expect((await db.web.query(SQL.startCheckout, [KEY_VERSION, hex(32), PRODUCT, VARIANT, 0, null])).rows[0].result).toBe("NOT_AUTHORIZED");
      expect((await db.web.query(SQL.cancelCheckout, [KEY_VERSION, hex(32), "ci_short"])).rows[0].result).toBe("NOT_AUTHORIZED");
      expect(await waiters()).toBe(0);
    } finally {
      await db.admin.query(SQL.rollback);
    }
    // Nothing was written by any of them.
    expect(await snapshotOf(db.admin)).toEqual(before);
    // The same for an expired and for a revoked session.
    const expiredSession = await newCredential(db.admin, "-25 hours", NOW);
    const revoked = await newCredential(db.admin);
    await db.admin.query(SQL.revokeSessionDirectly, [revoked.session]);
    for (const dead of [expiredSession, revoked]) {
      expect((await startCheckout(db.web, dead, PRODUCT, VARIANT, 0)).result).toBe("NOT_AUTHORIZED");
      expect((await db.web.query(SQL.cancelCheckout, [KEY_VERSION, dead.digest, "ci_short"])).rows[0].result).toBe("NOT_AUTHORIZED");
    }
    // Over the limit, a malformed request is still REQUEST_INVALID, and is not counted.
    const full = await newCredential(db.admin);
    await db.admin.query(SQL.insertWindow, [full.owner, "0 seconds", 30, "0 seconds"]);
    const fullWindow = await windowOf(db.admin, full.owner);
    expect((await startCheckout(db.web, full, PRODUCT, VARIANT, 0)).result).toBe("REQUEST_INVALID");
    expect(await windowOf(db.admin, full.owner)).toEqual(fullWindow);

    // PGT-131, under the limit. The test owner holds the OTHER owner's intent row for the whole of this block. A
    // cancellation and a replacement that name it return NOT_AUTHORIZED at once: had either tried to lock that row,
    // it would have waited for the test owner. The server reports no backend waiting on a lock.
    const underBefore = await snapshotOf(db.admin);
    await db.admin.query(SQL.begin);
    try {
      await db.admin.query(SQL.lockIntent, [theirs]);
      expect(await cancelCheckout(db.web, credential, theirs)).toBe("NOT_AUTHORIZED");
      expect((await startCheckout(db.web, credential, PRODUCT, VARIANT, 1, theirs)).result).toBe("NOT_AUTHORIZED");
      // A well-formed id of no intent at all behaves the same.
      expect(await cancelCheckout(db.web, credential, newId("ci"))).toBe("NOT_AUTHORIZED");
      expect((await startCheckout(db.web, credential, PRODUCT, VARIANT, 1, newId("ci"))).result).toBe("NOT_AUTHORIZED");
      expect(await waiters()).toBe(0);
    } finally {
      await db.admin.query(SQL.rollback);
    }
    // No side effects: nothing changed, the caller's counter included.
    expect(await snapshotOf(db.admin)).toEqual(underBefore);

    // PGT-131, over the limit: both are RATE_LIMITED, with identical counter changes, again while the foreign row
    // is held, so again without touching it.
    const over = await newCredential(db.admin);
    await db.admin.query(SQL.insertWindow, [over.owner, "0 seconds", 30, "0 seconds"]);
    const overBefore = await windowOf(db.admin, over.owner);
    let afterMissing: Awaited<ReturnType<typeof windowOf>> = null;
    let afterForeign: Awaited<ReturnType<typeof windowOf>> = null;
    await db.admin.query(SQL.begin);
    try {
      await db.admin.query(SQL.lockIntent, [theirs]);
      expect(await cancelCheckout(db.web, over, newId("ci"))).toBe("RATE_LIMITED");
      afterMissing = await windowOf(db.admin, over.owner);
      expect(await cancelCheckout(db.web, over, theirs)).toBe("RATE_LIMITED");
      afterForeign = await windowOf(db.admin, over.owner);
      expect((await startCheckout(db.web, over, PRODUCT, VARIANT, 1, theirs)).result).toBe("RATE_LIMITED");
      expect(await waiters()).toBe(0);
    } finally {
      await db.admin.query(SQL.rollback);
    }
    // The same change for the missing id and for the foreign id: one more throttled call each, nothing else.
    expect(afterMissing).toMatchObject({ window_calls: 30, window_throttled: 1, total_throttled: 1 });
    expect(afterForeign).toMatchObject({ window_calls: 30, window_throttled: 2, total_throttled: 2 });
    expect(afterMissing.window_started_at.getTime()).toBe(overBefore.window_started_at.getTime());
    expect(afterForeign.window_started_at.getTime()).toBe(overBefore.window_started_at.getTime());
    expect(await windowOf(db.admin, over.owner)).toMatchObject({ window_calls: 30, window_throttled: 3, total_throttled: 3 });
    expect(await auditOf(db.admin, over.owner)).toHaveLength(1);
    // The other owner's intent is exactly as it was.
    expect(await intentOf(db.admin, theirs)).toMatchObject({ state: "QUOTED", row_version: 2, owner_id: other.owner });
  });

  it("PGT-13: a quote and its item, as the function wrote them, can be neither updated nor deleted, by the test owner or by the function owner", async () => {
    const credential = await newCredential(db.admin);
    const started = await startCheckout(db.web, credential);
    const intentId = started.intent_id as string;
    const quoteId = started.quote_id as string;
    const before = await snapshotOf(db.admin);

    // The test owner has every privilege: what stops it is the table's own trigger, with its message.
    const expected: Array<[ImmutableKey, string]> = [
      ["touchQuote", "UPDATE is not permitted on quotes"],
      ["removeQuote", "DELETE is not permitted on quotes"],
      ["touchItem", "UPDATE is not permitted on quote_items"],
      ["removeItem", "DELETE is not permitted on quote_items"],
    ];
    const observed: Array<{ statement: string; sqlstate: string | null; message: string | null }> = [];
    for (const [statement] of expected) observed.push({ statement, ...(await immutableRowAttempt(db.admin, credential.owner, intentId, statement, quoteId)) });
    expect(observed).toEqual(expected.map(([statement, message]) => ({ statement, sqlstate: "23001", message })));

    // The function owner is not even granted UPDATE or DELETE on either table.
    for (const [statement] of expected) expect(await asFunctionOwner(db.admin, statement, [quoteId]), statement).toBe(INSUFFICIENT_PRIVILEGE);

    // The quote and its item are exactly as the function wrote them.
    expect(await snapshotOf(db.admin)).toEqual(before);
    expect((await db.admin.query(SQL.itemRows, [quoteId])).rows).toHaveLength(1);
  });

  it("PGT-119 (around the boundary): one quote is read as QUOTED just before its expiry and as QUOTE_EXPIRED just after, and nothing stored changes", async () => {
    // A quote one second from its expiry. It is read only when the server reports time to spare, and the reading
    // counts as "before" only if the server still reports the expiry ahead after the read has returned.
    const credential = await newCredential(db.admin);
    let observed: { intent: string; before: string; storedBefore: string; version: number } | null = null;
    for (let attempt = 1; attempt <= 5 && observed === null; attempt += 1) {
      const fixture = await insertFixtureCheckout(db.admin, credential, new Date(Date.now() - 899 * 1000), false);
      const margin = (await db.admin.query(SQL.quoteMargin, [fixture.intent])).rows[0];
      if (margin.passed === false && margin.remaining_seconds >= 0.3) {
        const read = await readCheckout(db.web, credential, fixture.intent);
        const stillAhead = (await db.admin.query(SQL.quoteMargin, [fixture.intent])).rows[0].passed === false;
        if (stillAhead) observed = { intent: fixture.intent, before: read.effective_status, storedBefore: read.stored_state, version: read.row_version };
      }
    }
    if (observed === null) throw new Error("no quote was read before its expiry in five attempts");
    expect(observed).toMatchObject({ before: "QUOTED", storedBefore: "QUOTED", version: 2 });

    let reached = false;
    for (let poll = 0; poll < 600 && !reached; poll += 1) {
      reached = (await db.admin.query(SQL.quoteMargin, [observed.intent])).rows[0].passed === true;
      if (!reached) await db.admin.query(SQL.shortSleep);
    }
    expect(reached).toBe(true);
    const after = await readCheckout(db.web, credential, observed.intent);
    // Derived, not stored: the effective status moved; the stored state and the row version did not.
    expect(after).toMatchObject({ result: "OK", effective_status: "QUOTE_EXPIRED", stored_state: "QUOTED", row_version: 2 });
    expect((await intentOf(db.admin, observed.intent)).state).toBe("QUOTED");
    expect((await listCheckouts(db.web, credential)).filter((row) => row.intent_id === observed?.intent).map((row) => row.effective_status)).toEqual(["QUOTE_EXPIRED"]);
    // The exact instant of expiry cannot be produced: no function takes a time. That the comparison is "at or
    // after" is asserted on the source of both read functions by the static suite (PGT-135).
  });
});
