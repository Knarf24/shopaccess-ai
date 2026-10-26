# Approved recommendation layout

Owner approved the desktop image concept in this conversation on October25, 2026. Base is PR30 main ba00a0ba49894f8e9a19f6b9a353fa038e5db571. Scope is the eligible charger recommendation state, not the other shopping states, permission page, payment page or financial rules.

- [x] Add render tests proving one heading/current step, real confirmed budget, device change and budget edit forms with current CSRF/draft/revision, collapsed evidence and conversation, and correct permission-versus-checkout action in English/Spanish.
- [x] Add a server-rendered layout with a Your choices sidebar, existing labelled illustration, product card, single main purchase action, and native details controls. Keep selected language visible; do not invent a language-switch action that the current needs route cannot support.
- [x] Scope white/blue/orange styling to this recommendation state, stack on narrow screens, allow text wrapping, preserve visible focus and labelled controls. Keep other needs states unchanged.
- [x] Check tests, typecheck, lint, build, source review and exact patch application. Record browser/VoiceOver limits honestly; do not commit, push or deploy.

Implementation uses existing Next/React server components and forms; no new dependency, session storage, price source or payment behavior. Change device uses the existing protected control; Change budget reveals the existing proposal operation and never silently confirms. The actual adapter asset is a labelled generic illustration, not the generated mockup photograph. Optional evidence and conversation remain accessible through native keyboard-operable disclosure controls.
