/** One line shown in the guided conversation. Session storage lives elsewhere. */
export interface ConversationTurn {
  readonly role: "shopper" | "assistant";
  readonly text: string;
}
