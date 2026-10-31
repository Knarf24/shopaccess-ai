import Link from "next/link";

/** The language of an unmatched address is unknown, so the message is shown in English and Spanish. */
export function NotFoundContent() {
  return (
    <main className="guided-presentation ui-refresh">
      <div className="presentation-column presentation-column-narrow not-found">
        <p className="gate-brand">ShopAccess AI</p>
        <section aria-labelledby="not-found-en" className="not-found-card">
          <h1 id="not-found-en" className="text-3xl font-semibold">This page was not found</h1>
          <p>The address may be wrong, or the page may have moved. ShopAccess AI is an evaluation demonstration with a simulated store.</p>
          <p><Link href="/">Back to the start</Link></p>
        </section>
        <section aria-labelledby="not-found-es" lang="es" className="not-found-card">
          <h2 id="not-found-es" className="text-2xl font-semibold">No se encontró esta página</h2>
          <p>Puede que la dirección sea incorrecta o que la página se haya movido. ShopAccess AI es una demostración de evaluación con una tienda simulada.</p>
          <p><Link href="/">Volver al inicio</Link></p>
        </section>
      </div>
    </main>
  );
}
