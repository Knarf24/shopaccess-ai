import type { ReactNode } from "react";
import Link from "next/link";
import { EVIDENCE } from "@/lib/compatibility/evidence";
import { formatUsd } from "@/lib/catalog/merchant-catalog";
import { chargerBudgetCopy } from "@/lib/i18n/charger-budget-copy";
import { chargerRecommendationCopy } from "@/lib/i18n/charger-recommendation-copy";
import { ControlFields, type ChargerTrackView } from "./ChargerConversationControls";
import { ChargerPurchaseCard } from "./ChargerPurchaseCard";
import { Icon } from "../Icon";
interface Props { language: "en" | "es"; csrfToken: string; track: ChargerTrackView; permitted: boolean; headingId: string; compatibility: ReactNode; conversation: ReactNode }
/** Eligible recommendation presentation only. The caller and existing server handlers retain authority. */
export function ChargerRecommendationLayout({ language, csrfToken, track, permitted, headingId, compatibility, conversation }: Props) {
 if (track.state !== "confirmed" || track.deviceId === null || track.budget?.confirmedCents == null) return null;
 const copy = chargerRecommendationCopy(language);
 const budgetCopy = chargerBudgetCopy(language);
 const device = EVIDENCE.devices[track.deviceId];
 return <section className="charger-rec-layout" aria-labelledby={headingId}>
  <header className="charger-rec-header"><Link href="/" prefetch={false} className="charger-rec-brand">ShopAccess AI</Link><span>{copy.language}</span></header>
  <ol className="charger-rec-progress" aria-label={copy.progress}>
   {copy.steps.map((step,index) => <li key={step} aria-current={index === 2 ? "step" : undefined} data-status={index < 2 ? "completed" : index === 2 ? "current" : "upcoming"}>
    <span className="charger-rec-step" aria-hidden="true">{index < 2 ? "✓" : index + 1}</span>
    <span>{index < 2 ? <span className="sr-only">{copy.completed}: </span> : null}{step}</span>
   </li>)}
  </ol>
  <div className="charger-rec-intro"><h1 id={headingId} tabIndex={-1}><Icon name="plug" className="ui-icon-lead" />{copy.title}</h1><p>{copy.subtitle} <span lang="en">{device.name}</span>.</p></div>
  <div className="charger-rec-grid">
   <aside className="charger-rec-choices" aria-labelledby="charger-choices-title">
    <h2 id="charger-choices-title">{copy.choices}</h2>
    <dl><dt>{copy.device}</dt><dd><span lang="en">{device.name}</span><small>{track.deviceId}</small></dd></dl>
    <form method="post" action="/shop/needs/charger-control"><ControlFields csrfToken={csrfToken} language={language} track={track} /><input type="hidden" name="action" value="change" /><button type="submit" className="charger-rec-link">{copy.changeDevice}</button></form>
    <div className="charger-rec-budget"><dl><dt>{copy.budget}</dt><dd className="charger-rec-budget-value">{formatUsd(track.budget.confirmedCents)} USD</dd></dl><p>{copy.confirmed}</p>
     <details className="charger-rec-edit"><summary>{copy.changeBudget}</summary>
      <form method="post" action="/shop/needs/charger-control"><ControlFields csrfToken={csrfToken} language={language} track={track} /><input type="hidden" name="action" value="propose_budget" />
       <label htmlFor="charger-budget">{budgetCopy.amountLabel}</label><input id="charger-budget" name="dollars" inputMode="numeric" pattern="[1-9][0-9]{1,4}" required defaultValue={String(track.budget.proposedCents / 100)} aria-describedby="charger-budget-hint" />
       <p id="charger-budget-hint">{budgetCopy.amountHint} {budgetCopy.disclosure}</p><button type="submit" className="charger-rec-secondary">{copy.reviewBudget}</button>
      </form>
     </details>
    </div>
   </aside>
   <ChargerPurchaseCard language={language} csrfToken={csrfToken} permitted={permitted} />
  </div>
  <details className="charger-rec-disclosure"><summary>{copy.why}</summary><div className="charger-rec-details-body">{compatibility}</div></details>
  <details className="charger-rec-disclosure"><summary>{copy.conversation}</summary><div className="charger-rec-details-body">{conversation}</div></details>
  <footer className="charger-rec-footer"><p>{copy.footnote}</p><form method="post" action="/shop/needs/charger-control"><ControlFields csrfToken={csrfToken} language={language} track={track} /><input type="hidden" name="action" value="stop" /><button type="submit" className="charger-rec-link">{copy.stop}</button></form></footer>
 </section>;
}
