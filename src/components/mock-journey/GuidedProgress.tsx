import type { JourneyCopy } from "@/lib/i18n/demo-copy";

const STEP_IDS = ["needs", "confirm", "results", "purchase"] as const;

export type GuidedStep = (typeof STEP_IDS)[number];

/** Noninteractive stage list. It does not navigate and does not clear a draft. */
export function GuidedProgress({ copy, current }: { readonly copy: JourneyCopy; readonly current: GuidedStep }) {
  const labels: Record<GuidedStep, string> = {
    needs: copy.pageTitle,
    confirm: copy.reviewTitle,
    results: copy.advisoryHeading,
    purchase: copy.confirmation.heading,
  };
  return (
    <ol className="journey-steps" aria-label={copy.pageTitle}>
      {STEP_IDS.map((id, index) => (
        <li key={id} aria-current={id === current ? "step" : undefined}>
          <span className="step-index">{index + 1}</span>
          <span className="step-label">{labels[id]}</span>
        </li>
      ))}
    </ol>
  );
}
