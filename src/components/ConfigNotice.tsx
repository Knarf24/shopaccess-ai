/** Shown when required security configuration is missing. Lists setting names only, never values. */
export function ConfigNotice({ errors }: { errors: readonly string[] }) {
  return (
    <section role="alert" className="rounded-lg border-2 border-red-700 p-4">
      <h2 className="font-semibold">The demonstration is not configured</h2>
      <p className="text-sm">
        Required security settings are missing or invalid, so the shopping flow is switched off. See README.md for local setup.
      </p>
      <ul className="list-disc pl-5 text-sm">
        {errors.map((error) => (
          <li key={error}>{error}</li>
        ))}
      </ul>
    </section>
  );
}
