import type { ReadinessAssessment } from "@/lib/readiness/engine";

const STATUS_LABELS = {
  READY: "Assessment: suits your stated needs",
  READY_WITH_CAVEATS: "Assessment: may suit your needs, with caveats",
  NOT_RECOMMENDED: "Assessment: not recommended for your stated needs",
  INSUFFICIENT_EVIDENCE: "Assessment: not enough reliable information",
} as const;

const OUTCOME_LABELS = { PASS: "Meets", CAVEAT: "Caveat", FAIL: "Does not meet", UNKNOWN: "Unknown" } as const;

const QUALITY_LABELS = {
  VERIFIED: "verified from the demo catalog",
  SHOPPER_STATED: "based on what you entered and the demo catalog",
  UNVERIFIED: "unverified external information",
  STALE: "information is out of date",
  CONTRADICTORY: "sources disagree",
  MISSING: "information is missing",
} as const;

/** Shows the deterministic assessment with the evidence behind each factor. Text only; status is never conveyed by colour alone. */
export function ReadinessPanel({
  assessment,
  explanation,
  explanationLabel = "Assistant explanation (local mock, advisory only): ",
}: {
  assessment: ReadinessAssessment;
  explanation: string | null;
  explanationLabel?: string;
}) {
  return (
    <section className="flex flex-col gap-2 rounded border border-zinc-300 p-3 text-sm dark:border-zinc-700">
      <p className="font-semibold">{STATUS_LABELS[assessment.status]}</p>
      <p>This is an assessment of fit, not permission or a recommendation to buy. Rule set {assessment.engineVersion}.</p>
      <ul className="flex flex-col gap-1">
        {assessment.factors.map((factor) => {
          const sources = [...new Set(factor.evidence.map((item) => item.sourceRef))];
          return (
            <li key={factor.factor}>
              <span className="font-medium capitalize">{factor.factor}</span>: {OUTCOME_LABELS[factor.outcome]}. {factor.reason}{" "}
              <span className="text-zinc-700 dark:text-zinc-300">
                (Evidence: {QUALITY_LABELS[factor.evidenceQuality]}
                {sources.length > 0 ? `; source: ${sources.join("; ")}` : ""}
                {factor.missing.length > 0 ? `; missing: ${factor.missing.join(", ")}` : ""})
              </span>
            </li>
          );
        })}
      </ul>
      {explanation ? (
        <p className="border-t border-zinc-300 pt-2 dark:border-zinc-700">
          <span className="font-medium">{explanationLabel}</span>
          {explanation}
        </p>
      ) : null}
    </section>
  );
}
