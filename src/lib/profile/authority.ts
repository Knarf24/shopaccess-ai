import type { DurableHost } from "@/lib/session/durable";
import type { PersistedDeviceProfile, PersistedProfileRevision } from "@/lib/session/snapshot-state";
import { decideProfileDelete, decideProfileSave, storedProfileOk, type ProfileDecision, type ProfileWrite } from "./model";

/**
 * Optional device profile for the website session that the caller already authenticated.
 * Liveness is read again inside the queued decision, from the clock at that moment. This authority does not touch
 * the session, so it does not move lastSeenAt or absoluteExpiresAt.
 */
export interface ProfileAuthority {
  read(sessionId: string): PersistedDeviceProfile | null;
  save(sessionId: string, input: ProfileWrite): Promise<ProfileDecision>;
  remove(sessionId: string, version: number): Promise<ProfileDecision>;
}

export interface ProfileDeps {
  readonly durable: DurableHost;
  /** Synchronous liveness of the published session. Called inside the decision, so it observes the clock then. */
  readonly sessionLive: (sessionId: string) => boolean;
}

function publish(decided: ProfileDecision): {
  readonly value: ProfileDecision;
  readonly profiles?: readonly PersistedDeviceProfile[];
  readonly revisions?: readonly PersistedProfileRevision[];
} {
  if (!decided.ok) return { value: decided };
  return {
    value: decided,
    ...(decided.profiles ? { profiles: decided.profiles } : {}),
    ...(decided.revisions ? { revisions: decided.revisions } : {}),
  };
}

export function createProfileAuthority(deps: ProfileDeps): ProfileAuthority {
  return {
    read(sessionId) {
      if (!deps.sessionLive(sessionId)) return null;
      const found = deps.durable.readProfiles().filter((profile) => profile.sessionId === sessionId);
      if (found.length !== 1 || !storedProfileOk(found[0])) return null;
      return found[0];
    },
    async save(sessionId, input) {
      if (!deps.sessionLive(sessionId)) return { ok: false, code: "SESSION_NOT_LIVE" };
      return deps.durable.decideProfiles<ProfileDecision>((existing, revisions) => {
        // Recheck on the published state at execution. Time spent waiting in the queue still counts toward expiry.
        const decided = decideProfileSave(existing, sessionId, input, deps.sessionLive(sessionId), revisions);
        return publish(decided);
      });
    },
    async remove(sessionId, version) {
      if (!deps.sessionLive(sessionId)) return { ok: false, code: "SESSION_NOT_LIVE" };
      return deps.durable.decideProfiles<ProfileDecision>((existing, revisions) =>
        publish(decideProfileDelete(existing, sessionId, version, deps.sessionLive(sessionId), revisions)),
      );
    },
  };
}

export type { ProfileCode, ProfileOutcome } from "./model";
