import { extensionCopy, revocationMessage } from "@/lib/i18n/extension-copy";
import type { JourneyLanguage } from "@/lib/i18n/language";

const utcTime = (date: Date) => date.toISOString().slice(11, 16) + " UTC";

/** The revocation result; the needs page's "skip to current step" link targets it after a revoke. */
export const PAIRED_ACCESS_RESULT_ID = "paired-access-result";

/** What the list shows of one grant. Never the token or its digest. */
export interface PairedGrant {
  readonly grantId: string;
  readonly label: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/** Paired side panels for this session, each with its own Revoke control (M2-2). */
export function PairedAccess({
  language,
  csrfToken,
  grants,
  revokedLabel,
}: {
  readonly language: JourneyLanguage;
  readonly csrfToken: string;
  readonly grants: readonly PairedGrant[];
  readonly revokedLabel: string | null;
}) {
  const copy = extensionCopy(language);
  const announcement = revocationMessage(language, revokedLabel, grants.length);
  return (
    <section aria-labelledby="paired-access-heading" className="flex flex-col gap-2">
      <h2 id="paired-access-heading" className="text-xl font-semibold">
        {copy.pairedHeading}
      </h2>
      <p role="status" id={PAIRED_ACCESS_RESULT_ID} tabIndex={announcement ? -1 : undefined}>
        {announcement ?? ""}
      </p>
      <p>{grants.length === 0 ? copy.pairedNone : copy.pairedExplanation}</p>
      {grants.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {grants.map((grant) => (
            <li key={grant.grantId}>
              <form method="post" action="/extension/revoke">
                <input type="hidden" name="csrfToken" value={csrfToken} />
                <input type="hidden" name="grantId" value={grant.grantId} />
                <input type="hidden" name="lang" value={language} />
                <button type="submit" className="underline">
                  {copy.revoke(grant.label)}
                </button>{" "}
                <span>
                  {copy.paired(utcTime(grant.createdAt))} {copy.expires(utcTime(grant.expiresAt))}
                </span>
              </form>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
