/**
 * Who a lid is. WhatsApp addresses one person by a phone jid and by a lid —
 * fifteen digits that read as a phone number and are not one — and says which
 * number a lid pairs with only now and then: on a contact, a group participant,
 * a chat, the account's own lid table. This is the one table of those pairings
 * and the one set of rules for reading it, so an id handed out, a name shown
 * and a vote opened can never disagree about who is who.
 *
 * Nothing here touches the socket, the store or the disk. Learning a pairing
 * is a table write; what a pairing moves — chats, rings, notes, pushnames — is
 * the service's business.
 */
import { jidNormalizedUser } from "baileys";

import { isGroupId, isStatusJid, resolveChatId } from "./ids.js";

/** The table's key for a lid: device and agent dropped, and `@lid` whichever lid server it came from. */
export function lidKey(lid: string): string {
  return `${jidNormalizedUser(lid).split("@")[0]}@lid`;
}

export class LidRegistry implements Iterable<[string, string]> {
  /** Lid → phone jid. The half a snapshot writes down. */
  private readonly phones = new Map<string, string>();
  /** Phone jid → lid, so a number can be named from what was filed under its lid. */
  private readonly lids = new Map<string, string>();

  /**
   * One pairing, both ways. True when the lid had no number yet or had another
   * one — the only case the written-down table changes, so the only one worth
   * a save.
   *
   * The way back only ever agrees with the table: a number names the lid it
   * was last learned with, for as long as that lid still pairs with it, so a
   * lid WhatsApp moves to a new number stops answering for the old one. A
   * number that gains a new lid does not take the pairing away from the older
   * lid: WhatsApp's own lid table keeps answering for that lid, and the next
   * read would learn it again and flip the number between the two.
   */
  learn(lid: string, pn: string): boolean {
    if (!lid || !pn) return false;
    const key = lidKey(lid);
    const phone = jidNormalizedUser(pn);
    const previous = this.phones.get(key);
    if (previous !== undefined && previous !== phone && this.lids.get(previous) === key) this.lids.delete(previous);
    this.phones.set(key, phone);
    this.lids.set(phone, key);
    return previous !== phone;
  }

  /** Lookups take the forms canonical and jidNormalizedUser produce, which is what the table is keyed by. */
  phoneOf(lid: string): string | undefined {
    return this.phones.get(lid);
  }

  lidOf(phone: string): string | undefined {
    return this.lids.get(phone);
  }

  /** The other id the same person goes by: a lid's number, a number's lid. */
  aliasOf(jid: string): string | undefined {
    return jid.endsWith("@lid") ? this.phones.get(jid) : this.lids.get(jid);
  }

  /**
   * The id wazap hands out: the number once it is known, the lid until then,
   * a group as it is. This reads what WhatsApp sent, inside event handlers
   * that must not throw, so a jid wazap does not address — a status broadcast,
   * a newsletter — comes back unchanged.
   */
  canonical(jid: string): string {
    if (!jid) return "";
    try {
      return this.resolve(jid);
    } catch {
      return jid;
    }
  }

  /** The same rules for an id a caller typed, where a malformed one is the caller's mistake and must say so. */
  resolve(input: string): string {
    return resolveChatId(input, (lid) => this.phones.get(lid));
  }

  /**
   * Every jid WhatsApp may have bound a vote to for these seeds: each one with
   * its device dropped, its canonical form, and the number or lid it pairs
   * with. Groups and the status feed are chats, not voters. The order is
   * fixed, so every retry tries the same spellings the same way.
   */
  spellings(seeds: ReadonlyArray<string | null | undefined>): string[] {
    const spellings: string[] = [];
    for (const seed of seeds) {
      if (!seed || isGroupId(seed) || isStatusJid(seed)) continue;
      const jid = jidNormalizedUser(seed);
      const canonical = this.canonical(jid);
      for (const one of [jid, canonical, this.phones.get(jid), this.lids.get(jid), this.lids.get(canonical)]) {
        if (one && !spellings.includes(one)) spellings.push(one);
      }
    }
    return spellings;
  }

  /**
   * Whether `jid` is the linked account. The socket's own lid counts even
   * with no pairing learned for it: the socket states that lid from the start,
   * and the pairing is only learned once a connection opens.
   */
  isSelf(jid: string, ownJid: string, ownLid?: string): boolean {
    if (!ownJid) return false;
    if (this.canonical(jid) === ownJid) return true;
    return ownLid !== undefined && jidNormalizedUser(ownLid) === jidNormalizedUser(jid);
  }

  /** The snapshot's `lids`: lid → phone jid, in the order the pairings were learned. */
  toJSON(): Record<string, string> {
    return Object.fromEntries(this.phones);
  }

  /**
   * A snapshot's `lids`, through the same guard and normalization as learn, so
   * lookups after a restart see exactly the pairings replaying the snapshot
   * teaches. Only lid → number comes back here: the way back is rebuilt when
   * the service replays each pairing through learn, after the snapshot's
   * contacts have taught theirs. Restoring it here would keep a number
   * pointing at a lid that a contact has since paired with another number.
   */
  hydrate(lids: Record<string, string>): void {
    for (const [lid, pn] of Object.entries(lids)) {
      if (lid && pn) this.phones.set(lidKey(lid), jidNormalizedUser(pn));
    }
  }

  /** Each pairing as [lid, phone jid]. A pairing learned while iterating is visited too, as with a Map. */
  [Symbol.iterator](): Iterator<[string, string]> {
    return this.phones.entries();
  }
}
