# Hands-free shopping implementation plan

Owner request: send icon; wake phrase activation; spoken shopping requests with automatic spoken replies. Website implementation first, retaining the separate purchase approval controls.

Use the existing browser recognition/synthesis services, with a visible explicit Enable hands-free action each time a page session starts. Audio may go to browser speech services even while awaiting the wake phrase; disclose this before enabling. This is a foreground browser transcription-based wake phrase, not on-device wake-word detection or an operating-system assistant. Do not claim support with browser closed/phone locked. Stop, visibility loss and errors disable the session.

Keep a single hands-free controller at the stable needs-page level across client router updates. Only final spoken shopping messages after Hey ShopAccess are automatically posted to /shop/needs/submit using the current form's CSRF/draft fields. Do not submit any confirmation, permission or checkout form. Pause recognition while speaking to prevent self-activation. No credential storage or new provider configuration.

- Add failing controller tests for wake gating, one-message delivery, stop/late events and pause during speech.
- Add send icon and fix mock schoolwork recognition for estudiar/estudios/clases/tareas; do not label the mock as live AI.
- Implement pure wake/dialogue controller and browser adapter; use existing POST handler with client router replacement to retain the enabled session.
- Show spoken summary/recommendation from server-owned fields; keep authoritative amounts and explicit confirmation.
- Run related tests/typecheck/lint/build and full suite; record environment failures and request independent source review.
- Package exact baseline-checked Mac update and update completion tracker. No automatic commit or deployment.

Open acceptance: browser microphone/autoplay restrictions, wake phrase reliability, Spanish pronunciation and mobile behavior. Wake-word goal remains partial because this implementation uses browser transcription, not local keyword inference.
