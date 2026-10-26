import type { JourneyCopy } from "@/lib/i18n/demo-copy";

const STEP_IDS = ["needs", "confirm", "results", "purchase"] as const;

export type GuidedStep = (typeof STEP_IDS)[number];

/** Noninteractive stage list. It does not navigate and does not clear a draft. */
export function GuidedProgress({ copy, current, complete = false }: { readonly copy: JourneyCopy; readonly current: GuidedStep; readonly complete?: boolean }) {
  const labels: Record<GuidedStep, string> = {
    needs: copy.pageTitle,
    confirm: copy.reviewTitle,
    results: copy.advisoryHeading,
    purchase: copy.confirmation.heading,
  };
  const currentIndex = STEP_IDS.indexOf(current);
  return (
    <ol className="journey-steps" aria-label={copy.pageTitle}>
      {STEP_IDS.map((id, index) => {
        const isCurrent = !complete && id === current;
        const isCompleted = complete || (currentIndex >= 0 && index < currentIndex);
        return (
          <li
            key={id}
            aria-current={isCurrent ? "step" : undefined}
            data-status={isCurrent ? "current" : isCompleted ? "completed" : "upcoming"}
          >
            <span className="step-index">{index + 1}</span>
            <span className="step-label">{labels[id]}</span>
          </li>
        );
      })}
    </ol>
  );
}
