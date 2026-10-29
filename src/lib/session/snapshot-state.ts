import { restorePermissions } from "../permissions/model";
import type { WorkloadRecord } from "../readiness/workload-record";
import { canonicalJson } from "../shared/canonical-json";
import type { ChargerTrack } from "./charger-clarification";
import type { ConversationState } from "./conversation";
import type { CommitResult, FoundationStore, PublishedBody } from "./snapshot-store";
import { SESSION_IDLE_TIMEOUT_MS } from "./service";
import type { NeedsDraft, SessionRecord } from "./store";

/**
 * Save-first state gate for the mock runtime (M2-1, docs/m2-1-plan.md §9).
 *
 * Every decision runs at the head of one writer queue against the state published at that moment; that is the
 * recheck. A change is a private candidate. It is committed to the snapshot store and published only after the
 * commit returns ready (after the directory flush). Readers never see a candidate.
 *
 * Any refused commit blocks the gate for the rest of the process. A definite refusal (nothing renamed) and an
 * indeterminate one (renamed, durability unknown) are reported separately; both make every later decision and read
 * unavailable, and the gate does not touch the store again.
 *
 * This module only uses types from snapshot-store. The one value importer of the store is src/server/runtime-access.ts.
 */

/** Needs-bound checkout selection state for one session. */
export interface PersistedSelection {
  readonly epoch: number;
  readonly closed: boolean;
}

export type Windows = Pick<PublishedBody, "allocation" | "admissionLogin">;

export type GrantScope = "conversation:read" | "conversation:write";

/** A conversation-scoped extension grant (M2-2). Only the keyed digest of its token is kept. */
export interface PersistedGrant {
  readonly grantId: string;
  readonly sessionId: string;
  readonly tokenDigest: string;
  readonly extensionOrigin: string;
  readonly installationId: string;
  readonly scopes: readonly GrantScope[];
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export type PermissionState = "active" | "reserved" | "executing" | "consumed" | "revoked" | "expired" | "outcome_unknown";

/**
 * An F07 purchase permission (M2-3, docs/m2-3-plan.md §3). One exact seller + product + variant binding, a maximum
 * quantity, a maximum final payable total and a concrete expiry. Single use; owned by one website session.
 */
export interface PersistedPermission {
  readonly permissionId: string;
  readonly sessionId: string;
  readonly merchantId: string;
  readonly productId: string;
  readonly variantId: string;
  readonly maxQuantity: number;
  readonly maxTotalCents: number;
  readonly currency: "USD";
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly state: PermissionState;
  /**
   * The checkout holding it: set exactly for `reserved`, `executing`, `consumed` and `outcome_unknown`. A `revoked` or
   * `expired` permission may keep the checkout that held it when it ended (so that checkout reports why); `active` never
   * has one. Only the state decides authority.
   */
  readonly checkoutIntentId: string | null;
  readonly changedAt: Date;
}

/** One optional device profile for a website session. A null field was not saved. */
export interface PersistedDeviceProfile {
  readonly sessionId: string;
  readonly version: number;
  readonly brand: string | null;
  readonly model: string | null;
}

/**
 * Last issued profile version for a session whose profile row is gone. No brand and no model.
 * A session has a profile, or one of these, or neither. Logout, expiry, and restore of a dead session drop it.
 */
export interface PersistedProfileRevision {
  readonly sessionId: string;
  readonly version: number;
}

/** The whole persisted application state. Values are treated as immutable: a decision returns a new state. */
export interface DurableState {
  readonly sessions: readonly SessionRecord[];
  readonly drafts: ReadonlyMap<string, NeedsDraft>;
  readonly conversations: ReadonlyMap<string, ConversationState>;
  readonly selections: ReadonlyMap<string, PersistedSelection>;
  readonly windows: Windows;
  readonly grants: readonly PersistedGrant[];
  readonly permissions: readonly PersistedPermission[];
  readonly profiles: readonly PersistedDeviceProfile[];
  readonly profileRevisions: readonly PersistedProfileRevision[];
  /** Charger clarification tracks (format 7, proposed), keyed by session and bound to that session's current draft. */
  readonly chargerTracks: ReadonlyMap<string, ChargerTrack>;
  readonly workloads?: ReadonlyMap<string, WorkloadRecord>;
  /**
   * In memory only, never written: drafts restored from a format without workload records (7, 8), whose missing record
   * may mean it was lost. Pruned to live drafts as the state changes.
   */
  readonly unrecoveredWorkloadDrafts?: ReadonlySet<string>;
}

/**
 * Builds the body to commit. Entries whose session is gone, and conversations and charger tracks for a replaced or
 * removed draft, are left out.
 */
export function bodyFromState(state: DurableState, format: 7 | 9 = 7): PublishedBody {
  const ids = new Set(state.sessions.map((session) => session.id));
  const drafts = [...state.drafts].filter(([sessionId]) => ids.has(sessionId));
  const draftOf = new Map(drafts.map(([sessionId, draft]) => [sessionId, draft.draftId]));
  return {
    allocation: state.windows.allocation,
    admissionLogin: state.windows.admissionLogin,
    sessions: state.sessions.map((session) => ({
      id: session.id,
      tokenDigest: session.tokenDigest,
      createdAt: session.createdAt.toISOString(),
      lastSeenAt: session.lastSeenAt.toISOString(),
      absoluteExpiresAt: session.absoluteExpiresAt.toISOString(),
      revokedAt: session.revokedAt ? session.revokedAt.toISOString() : null,
    })),
    drafts: drafts.map(([sessionId, draft]) => ({ ...draft, sessionId })),
    conversations: [...state.conversations]
      .filter(([sessionId, conversation]) => draftOf.get(sessionId) === conversation.draftId)
      .map(([sessionId, conversation]) => ({
        sessionId,
        draftId: conversation.draftId,
        interfaceLanguage: conversation.interfaceLanguage,
        turns: conversation.turns.map((turn) => ({ role: turn.role, text: turn.text })),
      })),
    selections: [...state.selections]
      .filter(([sessionId]) => ids.has(sessionId))
      .map(([sessionId, selection]) => ({ sessionId, epoch: selection.epoch, closed: selection.closed })),
    grants: state.grants
      .filter((grant) => ids.has(grant.sessionId))
      .map((grant) => ({
        grantId: grant.grantId,
        sessionId: grant.sessionId,
        tokenDigest: grant.tokenDigest,
        extensionOrigin: grant.extensionOrigin,
        installationId: grant.installationId,
        scopes: [...grant.scopes],
        createdAt: grant.createdAt.toISOString(),
        expiresAt: grant.expiresAt.toISOString(),
        revokedAt: grant.revokedAt ? grant.revokedAt.toISOString() : null,
      })),
    permissions: state.permissions
      .filter((permission) => ids.has(permission.sessionId))
      .map((permission) => ({
        permissionId: permission.permissionId,
        sessionId: permission.sessionId,
        merchantId: permission.merchantId,
        productId: permission.productId,
        variantId: permission.variantId,
        maxQuantity: permission.maxQuantity,
        maxTotalCents: permission.maxTotalCents,
        currency: permission.currency,
        createdAt: permission.createdAt.toISOString(),
        expiresAt: permission.expiresAt.toISOString(),
        state: permission.state,
        checkoutIntentId: permission.checkoutIntentId,
        changedAt: permission.changedAt.toISOString(),
      })),
    profiles: state.profiles
      .filter((profile) => ids.has(profile.sessionId))
      .map((profile) => ({ sessionId: profile.sessionId, version: profile.version, brand: profile.brand, model: profile.model })),
    profileRevisions: state.profileRevisions
      .filter((revision) => ids.has(revision.sessionId))
      .map((revision) => ({ sessionId: revision.sessionId, version: revision.version })),
    chargerTracks: [...state.chargerTracks]
      .filter(([sessionId, track]) => track.sessionId === sessionId && draftOf.get(sessionId) === track.draftId)
      .map(([, track]) => ({ sessionId: track.sessionId, draftId: track.draftId, state: track.state, deviceId: track.deviceId, revision: track.revision, ...(track.budget ? { budget: { ...track.budget } } : {}) })),
    ...(format === 9 ? {
      workloads: [...(state.workloads ?? new Map<string, WorkloadRecord>())]
        .filter(([sessionId, record]) => record.sessionId === sessionId && draftOf.get(sessionId) === record.draftId)
        .map(([, record]) => ({ ...record })),
    } : {}),
  };
}

export interface RecoveredState {
  readonly state: DurableState;
  /** Requests that were in flight when the process stopped. They are never replayed. */
  readonly interrupted: { readonly interpretations: number; readonly recommendations: number };
  /** Sessions not restored because they were revoked or past their idle or absolute lifetime. */
  readonly droppedSessions: number;
}

/**
 * Restores a published body at `now`.
 * - Revoked sessions, and sessions past their idle or absolute lifetime, are dropped with everything they own.
 * - Expired drafts are dropped with their conversation.
 * - An in-flight interpretation is released with the existing `unavailable` notice. Nothing is sent again.
 *   In flight means `interpretationPending`: claimed, and no result written yet. That flag is independent of the notice
 *   (confirmation clears it) and of confirmed values (a pending follow-up keeps them). A completed claim keeps its claim
 *   version, which is the duplicate protection, and is left unchanged.
 * - An in-flight recommendation becomes `failed` with no recommendation. The confirmation is kept; no call is made.
 * - Allocation and admission windows are kept as stored.
 */
export function restoreState(body: PublishedBody, now: Date): RecoveredState {
  const at = now.getTime();
  const sessions: SessionRecord[] = [];
  let droppedSessions = 0;
  for (const stored of body.sessions) {
    const record: SessionRecord = {
      id: stored.id,
      tokenDigest: stored.tokenDigest,
      createdAt: new Date(stored.createdAt),
      lastSeenAt: new Date(stored.lastSeenAt),
      absoluteExpiresAt: new Date(stored.absoluteExpiresAt),
      revokedAt: stored.revokedAt === null ? null : new Date(stored.revokedAt),
    };
    const live = record.revokedAt === null && at < record.absoluteExpiresAt.getTime() && at < record.lastSeenAt.getTime() + SESSION_IDLE_TIMEOUT_MS;
    if (live) sessions.push(record);
    else droppedSessions += 1;
  }
  const ids = new Set(sessions.map((session) => session.id));
  const selections = new Map<string, PersistedSelection>();
  for (const selection of body.selections) {
    if (ids.has(selection.sessionId)) selections.set(selection.sessionId, { epoch: selection.epoch, closed: selection.closed });
  }
  const drafts = new Map<string, NeedsDraft>();
  let interpretations = 0;
  let recommendations = 0;
  for (const { sessionId, ...stored } of body.drafts) {
    if (!ids.has(sessionId) || at >= stored.expiresAtMs) continue;
    let draft: NeedsDraft = stored;
    if (draft.interpretationPending) {
      interpretations += 1;
      draft = { ...draft, interpretationClaimVersion: null, interpretationPending: false, notice: "unavailable" };
    }
    if (draft.recommendationClaim === "pending") {
      recommendations += 1;
      draft = { ...draft, recommendationClaim: "failed", recommendation: null };
    }
    drafts.set(sessionId, draft);
  }
  const workloads = new Map<string, WorkloadRecord>();
  for (const record of body.workloads ?? []) {
    if (drafts.get(record.sessionId)?.draftId === record.draftId) {
      workloads.set(record.sessionId, { ...record });
    }
  }
  const conversations = new Map<string, ConversationState>();
  for (const conversation of body.conversations) {
    if (drafts.get(conversation.sessionId)?.draftId !== conversation.draftId) continue;
    conversations.set(conversation.sessionId, {
      draftId: conversation.draftId,
      interfaceLanguage: conversation.interfaceLanguage,
      turns: conversation.turns.map((turn) => ({ role: turn.role, text: turn.text })),
    });
  }
  // Only usable grants are restored: their session is live, they are not revoked, and they have not expired.
  const grants: PersistedGrant[] = body.grants
    .filter((grant) => ids.has(grant.sessionId) && grant.revokedAt === null && at < Date.parse(grant.expiresAt))
    .map((grant) => ({ ...grant, scopes: [...grant.scopes], createdAt: new Date(grant.createdAt), expiresAt: new Date(grant.expiresAt), revokedAt: null }));
  // Permissions of live sessions only. Reserved returns to active (checkouts do not survive a restart); executing becomes
  // outcome_unknown (a capture may have been sent); lapsed active/reserved become expired (docs/m2-3-plan.md §4).
  const permissions = restorePermissions(
    body.permissions
      .filter((permission) => ids.has(permission.sessionId))
      .map((permission) => ({
        ...permission,
        createdAt: new Date(permission.createdAt),
        expiresAt: new Date(permission.expiresAt),
        changedAt: new Date(permission.changedAt),
      })),
    now,
  );
  // Profiles of restored sessions only, copied as stored. Recovery does not rewrite brand or model text.
  const profiles = body.profiles
    .filter((profile) => ids.has(profile.sessionId))
    .map((profile) => ({ sessionId: profile.sessionId, version: profile.version, brand: profile.brand, model: profile.model }));
  // Charger tracks of restored drafts only, copied as stored: the state and revision are kept exactly, so a control issued
  // before the restart stays valid only while nothing changed. A dead session's or expired draft's track is dropped.
  const chargerTracks = new Map<string, ChargerTrack>();
  for (const track of body.chargerTracks) {
    if (drafts.get(track.sessionId)?.draftId !== track.draftId) continue;
    chargerTracks.set(track.sessionId, { sessionId: track.sessionId, draftId: track.draftId, state: track.state, deviceId: track.deviceId, revision: track.revision, ...(track.budget ? { budget: { ...track.budget } } : {}) });
  }
  // Markers of restored sessions only. A dead session's marker is dropped with the session. Text is not stored here.
  const profileRevisions = body.profileRevisions
    .filter((revision) => ids.has(revision.sessionId))
    .map((revision) => ({ sessionId: revision.sessionId, version: revision.version }));
  return {
    state: {
      sessions,
      drafts,
      conversations,
      selections,
      windows: { allocation: body.allocation, admissionLogin: body.admissionLogin },
      grants,
      permissions,
      profiles,
      profileRevisions,
      chargerTracks,
      workloads,
      // A body without a workloads array (formats 7 and 8) cannot say which drafts had a record.
      ...(body.workloads === undefined ? { unrecoveredWorkloadDrafts: new Set([...drafts.values()].map((draft) => draft.draftId)) } : {}),
    },
    interrupted: { interpretations, recommendations },
    droppedSessions,
  };
}

export type GateStatus =
  | { readonly kind: "ready" }
  | { readonly kind: "blocked"; readonly outcome: "definite" | "indeterminate" };

/** What a decision returns: its value, and the next whole state when it changes anything. */
export interface Decision<T> {
  readonly value: T;
  readonly next?: DurableState;
}

export type Decided<T> = { readonly status: "done"; readonly value: T } | { readonly status: "unavailable" };

export type PublishedRead = { readonly status: "ready"; readonly state: DurableState } | { readonly status: "unavailable" };

export interface StateGate {
  /**
   * Runs `decide` at the head of the writer queue against the published state. When it returns `next`, that state is
   * committed and published only after the commit is durable; the caller receives `done` only then. A refused commit
   * returns `unavailable`, publishes nothing and blocks the gate. A decision that throws rejects its own call and
   * changes nothing.
   */
  decide<T>(decide: (published: DurableState) => Decision<T>): Promise<Decided<T>>;
  /** The published state. Never a candidate. Unavailable once the gate is blocked. */
  read(): PublishedRead;
  status(): GateStatus;
  /** Called synchronously with each newly published state, after the commit is durable. */
  subscribe(listener: (state: DurableState) => void): void;
}

type CommitTarget = Pick<FoundationStore, "commit">;

export function createStateGate(store: CommitTarget, initial: DurableState, format: 7 | 9 = 7): StateGate {
  let published = initial;
  let publishedDigest = canonicalJson(bodyFromState(initial, format));
  let status: GateStatus = { kind: "ready" };
  let chain: Promise<unknown> = Promise.resolve();
  const listeners: Array<(state: DurableState) => void> = [];

  const run = async <T>(decide: (state: DurableState) => Decision<T>): Promise<Decided<T>> => {
    if (status.kind === "blocked") return { status: "unavailable" };
    const decision = decide(published);
    if (!decision.next || decision.next === published) return { status: "done", value: decision.value };
    const candidate = decision.next;
    const body = bodyFromState(candidate, format);
    const digest = canonicalJson(body);
    // Nothing persisted would change: no commit, and the published state stays the same object.
    if (digest === publishedDigest) return { status: "done", value: decision.value };
    let result: CommitResult;
    try {
      result = await store.commit(body);
    } catch {
      result = { status: "unavailable", outcome: "definite" };
    }
    if (result.status !== "ready") {
      status = { kind: "blocked", outcome: result.outcome };
      return { status: "unavailable" };
    }
    published = format === 9
      ? {
          ...candidate,
          workloads: new Map(
            (body.workloads ?? []).map((record) => [record.sessionId, record]),
          ),
        }
      : candidate;
    publishedDigest = digest;
    for (const listener of listeners) listener(published);
    return { status: "done", value: decision.value };
  };

  return {
    decide<T>(decide: (state: DurableState) => Decision<T>) {
      const next = chain.then(() => run(decide));
      chain = next.catch(() => undefined);
      return next;
    },
    read() {
      return status.kind === "blocked" ? { status: "unavailable" } : { status: "ready", state: published };
    },
    status() {
      return status;
    },
    subscribe(listener) {
      listeners.push(listener);
    },
  };
}

export type OpenedGate =
  | { readonly status: "ready"; readonly gate: StateGate; readonly interrupted: RecoveredState["interrupted"]; readonly droppedSessions: number }
  | { readonly status: "unavailable"; readonly code: string };

/**
 * Startup barrier body: reads the verified snapshot, applies recovery, and commits the recovered state durably before
 * any gate exists. The runtime is built only from a ready result.
 */
export async function recoverStateGate(store: FoundationStore, now: Date): Promise<OpenedGate> {
  const read = store.readPublished();
  if (read.status !== "ready") return { status: "unavailable", code: "snapshot-unavailable" };
  const recovered = restoreState(read.value.body, now);
  const format = read.value.format === 9 ? 9 : 7;
  const committed = await store.commit(bodyFromState(recovered.state, format));
  if (committed.status !== "ready") return { status: "unavailable", code: committed.outcome === "definite" ? "recovery-commit-definite" : "recovery-commit-indeterminate" };
  return { status: "ready", gate: createStateGate(store, recovered.state, format), interrupted: recovered.interrupted, droppedSessions: recovered.droppedSessions };
}
