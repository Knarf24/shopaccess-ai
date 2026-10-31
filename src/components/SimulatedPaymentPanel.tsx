import type { JourneyCopy } from "@/lib/i18n/demo-copy";
import { paymentPreviewCopy, type SimulationStep } from "@/server/simulation";
import type { CheckoutView } from "@/server/views";

/** The ordinary next step in the local simulation; failure, lost-response and cancel paths stay outlined. */
const FORWARD_STEPS: ReadonlySet<SimulationStep> = new Set<SimulationStep>(["create_order", "buyer_approve", "capture"]);

/** Sandbox checkout actions. Approval and capture are separate, and success is only a verified capture. */
export function SandboxCheckoutActions({
  view,
  csrfToken,
  copy,
}: {
  view: CheckoutView;
  csrfToken: string;
  copy: JourneyCopy["sandboxCheckout"];
}) {
  return (
    <section aria-labelledby="sandbox-heading" className="flex flex-col gap-4 rounded-lg border border-zinc-400 p-4">
      <h2 id="sandbox-heading" tabIndex={-1} className="text-xl font-semibold">
        {copy.heading}
      </h2>
      {view.state === "CAPTURED_VERIFIED" ? <p role="status">{copy.captured}</p> : null}
      {/* While a purchase-permission refusal applies (M2-3), approval and capture are not offered: the gate would refuse. */}
      {view.state === "APPROVED_VERIFIED" && !view.permissionRefusal ? (
        <>
          <p>{copy.approved}</p>
          <form method="post" action={`/checkout/${view.intentId}/capture`}>
            <input type="hidden" name="csrfToken" value={csrfToken} />
            <button type="submit" className="rounded border border-zinc-600 px-3 py-2">{copy.capture}</button>
          </form>
        </>
      ) : null}
      {view.state === "USER_CONFIRMED" && !view.permissionRefusal ? (
        <form method="post" action={`/checkout/${view.intentId}/approve`}>
          <input type="hidden" name="csrfToken" value={csrfToken} />
          <button type="submit" className="rounded border border-zinc-600 px-3 py-2">{copy.approve}</button>
        </form>
      ) : null}
      {view.state === "AWAITING_APPROVAL" || view.state === "APPROVAL_CHECK_PENDING" ? <p>{copy.awaiting}</p> : null}
      {view.state === "CANCELED_LOCAL" ? <p>{copy.canceled}</p> : null}
      {/* Codex finding 2: a provider-proven decline is explained from the saved state, never from a URL code. */}
      {view.state === "DECLINED_RETRYABLE" ? <p>{copy.declined}</p> : null}
      {view.state === "MANUAL_REVIEW" || view.state === "ORDER_CREATE_UNKNOWN" || view.state === "CAPTURE_UNKNOWN" ? <p>{copy.unknown}</p> : null}
      {/*
        A refusal tells the shopper to cancel (M2-3, second review finding 2). The existing protected cancel route, offered
        only while a refusal applies and cancelling is still valid (before any capture; `steps` keeps "cancel" exactly then).
      */}
      {view.permissionRefusal && view.steps.includes("cancel") ? (
        <form method="post" action={`/checkout/${view.intentId}/cancel`}>
          <input type="hidden" name="csrfToken" value={csrfToken} />
          <button type="submit" className="rounded border border-zinc-600 px-3 py-2">{copy.cancel}</button>
        </form>
      ) : null}
    </section>
  );
}

/** Shows the SIMULATED payment lifecycle: local state, what the mock provider reported, and the controls that drive the mock. */
export function SimulatedPaymentPanel({ view, csrfToken, lang }: { view: CheckoutView; csrfToken: string; lang?: "en" | "es" }) {
  const copy = paymentPreviewCopy(lang);
  return (
    <section aria-labelledby="sim-heading" lang={lang} className="flex flex-col gap-4 rounded-lg border-2 border-amber-600 p-4">
      <h2 id="sim-heading" tabIndex={-1} className="text-xl font-semibold">
        {copy.heading}
      </h2>
      <p id="sim-disclosure" className="text-sm">
        {copy.disclosure}
      </p>
      <div role="status" data-state={view.state} className="rounded bg-zinc-100 p-3 text-black">
        <p>
          <span className="font-medium">{copy.status}</span>
          <code>{view.state}</code>
        </p>
        <p className="text-sm">{copy.states[view.state]}</p>
      </div>

      {view.steps.length > 0 ? (
        <form method="post" action={`/checkout/${view.intentId}/simulate`} className="flex flex-col gap-2">
          <input type="hidden" name="csrfToken" value={csrfToken} />
          <fieldset aria-describedby="sim-disclosure" className="flex flex-col gap-2">
            <legend className="font-medium">{copy.controls}</legend>
            {view.steps.map((step: SimulationStep) => (
              <button
                key={step}
                type="submit"
                name="step"
                value={step}
                className={`rounded border border-zinc-600 px-3 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2${FORWARD_STEPS.has(step) ? " shopping-primary-action" : ""}`}
              >
                {copy.steps[step]}
              </button>
            ))}
          </fieldset>
        </form>
      ) : (
        <p className="text-sm">{copy.noSteps}</p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="text-left font-medium">{copy.history}</caption>
          <thead>
            <tr>
              <th scope="col" className="pr-3">{copy.event}</th>
              <th scope="col" className="pr-3">{copy.actor}</th>
              <th scope="col">{copy.change}</th>
            </tr>
          </thead>
          <tbody>
            {view.transitions.map((record) => (
              <tr key={record.eventId}>
                <td className="pr-3">{record.eventType}</td>
                <td className="pr-3">{record.actor}</td>
                <td>
                  {record.from} → {record.to}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {view.observations.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="text-left font-medium">{copy.observations}</caption>
            <thead>
              <tr>
                <th scope="col" className="pr-3">{copy.source}</th>
                <th scope="col" className="pr-3">{copy.subject}</th>
                <th scope="col">{copy.reportedStatus}</th>
              </tr>
            </thead>
            <tbody>
              {view.observations.map((observation) => (
                <tr key={observation.id}>
                  <td className="pr-3">{observation.source}</td>
                  <td className="pr-3">{observation.subject}</td>
                  <td>{observation.observedStatus}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {view.operations.length > 0 ? (
        <ul className="text-sm">
          {view.operations.map((operation) => (
            <li key={operation.id}>
              {copy.operation} {operation.type} #{operation.sequence}: {operation.state}, {copy.attempts} {operation.attemptCount}, {copy.requestId}{" "}
              <code>{operation.providerRequestId}</code>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
