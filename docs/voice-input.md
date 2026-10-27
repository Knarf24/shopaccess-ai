# Shopping voice controls

October 26, 2026. Website implementation; real microphone and audio acceptance remain open. C12 is in progress, not complete. Wake-word activation and extension voice are separate unfinished tasks.

Use microphone starts one utterance in the page language (en-US or es-ES). The visible privacy notice states that the browser may send audio to its speech service. No microphone starts on page load. Dictation appends to the existing message; the shopper edits and selects Send. Voice never submits a form, confirms a need or purchase, changes permission, or starts payment.

Stop listening asks the browser to finish and return pending final words, with a ten-second timeout. Manual typing, form submission, switching away and component cleanup cancel recognition and ignore late results. These actions also stop read-aloud. Permission denial, missing browser support, no speech, service failure and overlong output show localized status and retain typed input. No recorded audio is stored by ShopAccess. Recognition is supplied by the browser; do not claim offline/local processing.

Read reply aloud reads the latest displayed assistant conversation line (or first-entry prompt) on explicit request. It does not automatically speak over a screen reader. A stop control cancels it. Available device voices vary; the page language is requested, but accent and Spanish pronunciation require listening tests. Product comparison and checkout speech still require acceptance and further integration.

Source references: https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition and https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis, checked October 26. Recognition is not supported in every browser and may require an external browser speech service.

Acceptance on Mac after applying: open the local shopping page; choose Use microphone and allow access; dictate a short non-personal shopping request; verify editable text and explicit Send; verify Stop listening and manual typing preserve the draft; choose Read reply aloud and Stop reading; repeat in Spanish. Do not speak codes, passphrases or payment information. Browser speech activation is not part of the offline test run and must be deliberately initiated by the owner.
