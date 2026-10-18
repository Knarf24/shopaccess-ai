import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DeviceProfileForm } from "@/components/DeviceProfileForm";
import { profileCopy } from "@/lib/i18n/profile-copy";

describe("device profile page text", () => {
  it("renders saved brand and model as text in English and Spanish", () => {
    const hostile = `<img src=x onerror=alert(1)>`;
    for (const language of ["en", "es"] as const) {
      const html = renderToStaticMarkup(
        <DeviceProfileForm
          language={language}
          csrfToken="csrf-test"
          notice={profileCopy(language).saved}
          profile={{ version: 2, brand: hostile, model: "Aspire 14", brandSaved: true, modelSaved: true }}
        />,
      );
      expect(html).not.toMatch(/<img\b/);
      expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
      expect(html).toContain(profileCopy(language).brandLabel);
      expect(html).toContain(profileCopy(language).modelConsent);
      expect(html).toContain(profileCopy(language).save);
      expect(html).toContain(`action="/shop/profile/save"`);
      expect(html).toContain(`action="/shop/profile/delete"`);
      expect(html).toContain(`name="version" value="2"`);
      expect(html).not.toContain("compatible");
    }
    expect(renderToStaticMarkup(
      <DeviceProfileForm language="es" csrfToken="csrf-test" notice={null} profile={{ version: 0, brand: "", model: "", brandSaved: false, modelSaved: false }} />,
    )).toContain(profileCopy("es").empty);
  });
});
