import type { JourneyLanguage } from "@/lib/i18n/language";
import { profileCopy } from "@/lib/i18n/profile-copy";
import type { DeviceProfileDisplay } from "@/types/device-profile";

export const PROFILE_HEADING_ID = "device-profile-heading";
export const PROFILE_NOTICE_ID = "device-profile-notice";

/**
 * The device-profile form. Values are rendered as text. This module has no client directive and does not read storage.
 */
export function DeviceProfileForm({
  language,
  csrfToken,
  profile,
  notice,
}: {
  language: JourneyLanguage;
  csrfToken: string;
  profile: DeviceProfileDisplay;
  notice: string | null;
}) {
  const copy = profileCopy(language);
  return (
    <div lang={language} className="flex flex-col gap-4">
      <a className="skip-link" href={`#${PROFILE_HEADING_ID}`}>
        {copy.skip}
      </a>
      <h1 id={PROFILE_HEADING_ID} tabIndex={-1} className="text-3xl font-semibold">
        {copy.pageTitle}
      </h1>
      <p>{copy.intro}</p>
      {notice ? (
        <p id={PROFILE_NOTICE_ID} role="alert">
          {notice}
        </p>
      ) : null}
      {profile.version === 0 ? <p>{copy.empty}</p> : null}
      {profile.brandSaved ? (
        <p>
          {copy.savedBrand}: {profile.brand}
        </p>
      ) : null}
      {profile.modelSaved ? (
        <p>
          {copy.savedModel}: {profile.model}
        </p>
      ) : null}
      <form method="post" action="/shop/profile/save" className="flex flex-col gap-3">
        <input type="hidden" name="csrfToken" value={csrfToken} />
        <input type="hidden" name="lang" value={language} />
        <input type="hidden" name="version" value={String(profile.version)} />
        <div>
          <label htmlFor="device-brand">{copy.brandLabel}</label>
          <input id="device-brand" name="brand" type="text" maxLength={80} defaultValue={profile.brand} autoComplete="off" />
        </div>
        <div>
          <input id="device-brand-consent" name="brandConsent" type="checkbox" value="yes" defaultChecked={profile.brandSaved} />
          <label htmlFor="device-brand-consent">{copy.brandConsent}</label>
        </div>
        <div>
          <label htmlFor="device-model">{copy.modelLabel}</label>
          <input id="device-model" name="model" type="text" maxLength={80} defaultValue={profile.model} autoComplete="off" />
        </div>
        <div>
          <input id="device-model-consent" name="modelConsent" type="checkbox" value="yes" defaultChecked={profile.modelSaved} />
          <label htmlFor="device-model-consent">{copy.modelConsent}</label>
        </div>
        <button type="submit">{copy.save}</button>
      </form>
      {profile.version > 0 ? (
        <form method="post" action="/shop/profile/delete">
          <input type="hidden" name="csrfToken" value={csrfToken} />
          <input type="hidden" name="lang" value={language} />
          <input type="hidden" name="version" value={String(profile.version)} />
          <button type="submit">{copy.remove}</button>
        </form>
      ) : null}
    </div>
  );
}
