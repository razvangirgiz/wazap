/**
 * Poll votes and event responses, read back. WhatsApp encrypts each one under
 * the secret its poll or event was created with, and binds the ciphertext to
 * the creator's and the voter's jid as strings — so a vote opens only with the
 * exact spelling WhatsApp used, number or lid, and which one it used is not
 * written anywhere. The caller hands over the spellings it knows; each pair is
 * tried in order until one authenticates. Pure: no socket, no store, no I/O.
 */
import { createHash } from "node:crypto";
import { decryptEventResponse, decryptPollVote, proto, type WAMessage } from "baileys";
import { isEvent, messageSecretOf, pollOf, type EncryptedVote } from "./messages.js";

/** What a vote said, and the spellings that opened it. */
export interface VoteReading {
  /** The option names chosen, or one of "going", "maybe", "not_going"; empty withdraws the vote. */
  choice: string[];
  /** How many options the vote selected, matched or not; for a poll only. */
  selected: number;
  creator: string;
  voter: string;
}

const RESPONSES: Partial<Record<number, string>> = {
  [proto.Message.EventResponseMessage.EventResponseType.GOING]: "going",
  [proto.Message.EventResponseMessage.EventResponseType.MAYBE]: "maybe",
  [proto.Message.EventResponseMessage.EventResponseType.NOT_GOING]: "not_going",
};

/** A vote names each option by the SHA-256 of its name, never by the name. */
function optionHash(name: string): string {
  return createHash("sha256").update(Buffer.from(name)).digest("hex");
}

/**
 * Open `vote` against the poll or event `target`, trying every creator and
 * voter spelling in the order given. Undefined when the target is the wrong
 * kind, carries no secret, or no pair of spellings authenticates.
 */
export function readVote(
  vote: EncryptedVote,
  target: WAMessage,
  creators: readonly string[],
  voters: readonly string[]
): VoteReading | undefined {
  const secret = messageSecretOf(target);
  const id = vote.targetKey.id;
  if (!secret || !id) return undefined;
  const poll = vote.kind === "poll" ? pollOf(target) : undefined;
  if (vote.kind === "poll" ? !poll : !isEvent(target)) return undefined;
  const encrypted = { encPayload: vote.payload, encIv: vote.iv };
  for (const creator of new Set(creators)) {
    for (const voter of new Set(voters)) {
      try {
        if (poll) {
          const opened = decryptPollVote(encrypted, {
            pollCreatorJid: creator,
            pollMsgId: id,
            pollEncKey: secret,
            voterJid: voter,
          });
          const names = new Map(poll.options.map((name) => [optionHash(name), name]));
          const selected = opened.selectedOptions ?? [];
          const choice = selected.flatMap((hash) => {
            const name = names.get(Buffer.from(hash).toString("hex"));
            return name === undefined ? [] : [name];
          });
          return { choice, selected: selected.length, creator, voter };
        }
        const opened = decryptEventResponse(encrypted, {
          eventCreatorJid: creator,
          eventMsgId: id,
          eventEncKey: secret,
          responderJid: voter,
        });
        const answer = RESPONSES[opened.response ?? -1];
        return { choice: answer ? [answer] : [], selected: 0, creator, voter };
      } catch {
        // A wrong spelling fails authentication; the next pair may be the one.
      }
    }
  }
  return undefined;
}
