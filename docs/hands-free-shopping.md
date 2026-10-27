# Foreground hands-free shopping

Open Talk to ShopAccess, read the audio disclosure, then select Enable hands-free. Allow the microphone if asked. Say “Hey ShopAccess” or “Hey Shop Access AI”, followed by a shopping request. Replies are read aloud, then listening resumes for the next shopping message. Spanish also accepts “Hola ShopAccess” and “Oye ShopAccess”.

This is browser transcription with a wake-phrase gate, not an operating-system assistant or an on-device keyword detector. Audio may be processed by the browser speech service even before the wake phrase. The page must remain visible; closing it, switching away, Stop hands-free, manual typing or errors disables the session. A minute without recognized speech also stops it. A normal full-page navigation or reload requires enabling it again. Browser speech support, permission and automatic playback vary. Typing and individual microphone/read-aloud controls remain available.

After the wake phrase, final shopping messages are sent automatically. Recognition pauses while the reply is spoken. No permission, confirmation or checkout form is submitted by voice. A message already sent may finish after Stop; check the page before retrying. No audio or new credentials are stored by this feature.

Local preview uses the existing mock interpreter, not a live AI provider. Numeric budgets and supported use phrases are recognized; the mock does not understand arbitrary conversation or all spelled-out numbers. “Para estudiar. Mi presupuesto es de 600 dólares” is covered by a regression test.

Validation is recorded in the transfer package RESULTS.md. Synthetic browser speech tests are separate from real microphone, wake reliability, pronunciation, mobile and accessibility acceptance. Nothing is committed or deployed by the transfer.
