# Conversation-first shopping implementation plan

Goal: make the existing shopping conversation the main entry and support contextual corrections without repeating known details.

Architecture: retain native POST forms, saved needs drafts, strict advisory output and explicit confirmation. Put optional first-entry structured controls inside a native disclosure. Send only validated saved use/budget to the interpreter on follow-up, separately from shopper text; preserve first-request behavior. This is the first C01/C02 implementation task, not completion of the full tracker.

Stack: existing Next.js 16/React/TypeScript; no new dependencies or provider calls.

Specification: owner direction and ShopAccess-completion-tracker.md, October 26.

Constraints: retain CSRF/session/draft-version checks, model output validation, privacy notice, fallback fields, and spending/confirmation authority. Do not change provider configuration, store format or deployment.

Review focus: first-request transport unchanged; invalid context omitted; contextual corrections withdraw confirmation; fallback accessible without JavaScript; limited/unavailable AI leaves controls reachable.

- [ ] Add failing rendered-entry tests for collapsed optional controls, EN/ES message actions and open fallback on errors.
- [ ] Add failing provider-wire and real-handler tests for validated saved follow-up context and no implicit confirmation.
- [ ] Implement disclosure/copy and context request wiring.
- [ ] Run related tests/typecheck/lint and full suite; report environmental failures separately.
- [ ] Prepare reviewable patch against an exact saved baseline, with Mac application checks. Update completion tracker. No automatic commit, push or deployment.
