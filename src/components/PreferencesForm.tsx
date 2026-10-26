import { Icon } from "./Icon";
const USES = [
  ["schoolwork", "Schoolwork"],
  ["programming", "Programming"],
  ["general_productivity", "General productivity"],
] as const;

/** Plain GET form: works without JavaScript and with keyboard alone. */
export function PreferencesForm({ use, budget }: { use?: string; budget?: string }) {
  return (
    <form method="get" action="/session/start" className="flex flex-col gap-4 rounded-lg border border-zinc-400 p-4 sm:flex-row sm:items-end">
      <div className="flex flex-col gap-1">
        <label htmlFor="pref-use" className="font-medium">
          <span className="label-line"><Icon name="laptop" />What will you mainly use the laptop for?</span>
        </label>
        <select id="pref-use" name="use" defaultValue={use ?? "schoolwork"} required className="rounded border border-zinc-500 bg-white px-2 py-2 text-black">
          {USES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="pref-budget" className="font-medium">
          <span className="label-line"><Icon name="budget" />Your budget (USD)</span>
        </label>
        <input
          id="pref-budget"
          name="budget"
          type="text"
          inputMode="numeric"
          pattern="[1-9][0-9]{1,4}"
          defaultValue={budget ?? ""}
          required
          aria-describedby="pref-budget-help"
          className="rounded border border-zinc-500 bg-white px-2 py-2 text-black"
        />
        <span id="pref-budget-help" className="text-sm">
          Enter a whole dollar amount, for example 800.
        </span>
      </div>
      <button type="submit" className="shopping-primary-action rounded bg-blue-800 px-4 py-2 font-medium text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
        <Icon name="search" />Find my laptop
      </button>
    </form>
  );
}
