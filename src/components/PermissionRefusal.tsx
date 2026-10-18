import { permissionCopy, type PermissionRefusalCode } from "@/lib/i18n/permission-copy";
import type { JourneyLanguage } from "@/lib/i18n/language";

/**
 * A checkout step refused by F07 (M2-3), in the shopper's language, with a link to manage permissions. When the payment
 * outcome is already uncertain (`underReview`), it says so instead and never suggests paying again.
 */
export function PermissionRefusal({
  language,
  code,
  underReview = false,
  id,
}: {
  readonly language: JourneyLanguage;
  readonly code: PermissionRefusalCode;
  readonly underReview?: boolean;
  readonly id?: string;
}) {
  const copy = permissionCopy(language);
  return (
    <p id={id} tabIndex={id ? -1 : undefined} role="alert" className="rounded border-2 border-red-700 p-3">
      {underReview ? (
        copy.outcomeUnderReview
      ) : (
        <>
          {copy.refusals[code]} <a href={`/shop/permissions?lang=${language}`}>{copy.managePermissions}</a>
        </>
      )}
    </p>
  );
}
