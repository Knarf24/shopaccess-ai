/** Call only after the matching server reply has rendered. Failure/cancel paths never call this. */
export function clearAcknowledgedVoiceDraft(field: { value: string; readonly readOnly: boolean }, sentText: string | null): void {
  if (sentText !== null && field.readOnly && field.value === sentText) field.value = "";
}
