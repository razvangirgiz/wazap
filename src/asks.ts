/**
 * Whether a message's words ask something of the user: the judgment
 * get_unanswered and catch_up's `waiting` share, so the two lists never
 * disagree about who is waiting. Pure: it reads words, never a protobuf.
 */

/** Words that make a message read as something asked of the user, when it has no question mark. */
const ASK_PATTERN =
  /\b(te rog|v[ăa] rog|po[țt]i|pute[țt]i|ai putea|a[țt]i putea|c[âa]nd|c[âa]t|unde|trimite|trimi[țt]i|sun[ăa]|spune-mi|zi-mi|confirm[ăai]?|urgent|please|can you|could you|would you|when|where|how much|send me|let me know|need)\b/i;

/** A question mark or a request word, once links are taken out: a link's query string is not a question. */
export function wordsAsk(text: string): boolean {
  const words = text.replace(/https?:\/\/\S+/g, "");
  return words.includes("?") || ASK_PATTERN.test(words);
}

/**
 * A message that asks: never a call; a voice note nobody transcribed yet is
 * an ask until proven otherwise; anything else by its words (a voice note's
 * transcript included).
 */
export function readsAsAsk(message: { type: string; text: string; transcript: string | null }): boolean {
  if (message.type === "call") return false;
  if (message.type === "voice" && message.transcript === null) return true;
  return wordsAsk(message.transcript === null ? message.text : `${message.text} "${message.transcript}"`);
}
