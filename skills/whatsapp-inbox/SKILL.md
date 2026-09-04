---
name: whatsapp-inbox
description: Triage the user's WhatsApp. Use when they ask what they missed, what's unread, who is waiting on a reply, what needs attention today, or whom they forgot to answer. Read-only; it sends nothing and marks nothing read.
---

# WhatsApp inbox triage

Deliverable: a short, ranked list of what needs the user, with everything else compressed to one line. The user should finish reading in under a minute.

## Collect

1. `get_recent_messages` with the window the user implied (default 24h; "this week" = 168). If the result says `sync: "in_progress"`, wait 5 seconds and call it again once. Pass `include_previews: true` when the window holds photos, so "[image]" becomes something you can describe; the first call over many photos takes a few seconds.
2. `list_chats` with `filter: "unread"` to catch chats whose activity predates the window.
3. `get_unanswered` for who is still waiting: it returns only chats whose last word is theirs and asks for something, with the ask quoted. For "whom did I forget", pass `min_age_hours: 48`. Do not rebuild this from `list_chats`; the tool already skips conversations that ended in "ok, thanks".

Done collecting when every chat with unread messages appears in exactly one bucket below.

## Triage

Sort each chat into one bucket:

- **Needs you**: a direct question to the user, a request, a mention of the user in a group (`sender` is not the user and the text addresses them or quotes one of their messages), or money/dates/decisions awaiting them.
- **Probably handled by call**: a *Needs you* candidate the user has since called. See *Calls* below.
- **FYI**: information with no ask. Shipping updates, "ok thanks", group chatter that reached a conclusion.
- **Noise**: promotions, broadcast lists, groups the user is muted in (`muted_until` in the future), forwards without a question.

Rank *Needs you* by: people over groups, older unanswered over newer, money and deadlines first.

### Calls

A call after someone's ask is evidence the user dealt with it. For every *Needs you* candidate from an individual chat, look for a `call` message in that chat newer than the ask: the calls already in the window, or `read_messages` on that chat with `types: ["call"]`. A call whose `call.outcome` is `answered` moves the item to *Probably handled by call*, carrying when it was and how long it ran, and ending in a question, because the call may have been about something else:

`Ana — asked about Thursday 10:00; you spoke for 6 min on Tue 14:10. Confirm?`

Missed, rejected and unanswered calls are evidence of nothing, and those items stay in *Needs you*.

### Voice notes

A voice note carrying a `transcript` is text: triage it on what was said and quote
the transcript, not the placeholder. One whose text is still `[voice message · 0:42]`
was never transcribed, so you do not know what is in it and must not infer it from
who sent it. `transcribe_audio(message_id)` reads one on demand. If that answers
`TRANSCRIBE_UNAVAILABLE`, gather every such note into one closing line:

*3 voice notes not transcribed (Ana 0:42, Dan 1:15, Bloc 12 0:08). Turn it on with `wazap config transcribe`.*

One line for all of them, never one per item, and never a repeat of the offer.

## Report

```
Needs you (3)
1. Ana — asks if Thursday 10:00 works for the notary. 5h ago.
2. Bloc 12 group — Mihai needs your vote on the roof quote by Friday. 1d ago.
3. Dan — sent the contract PDF, waiting for your comments. 2d ago.

Probably handled by call (1)
1. Ana — asked about Thursday 10:00; you spoke for 6 min on Tue 14:10. Confirm?

FYI: Curier (delivered), Mama (photos), Team (retro moved to Tuesday).
Noise: 4 promo chats.
```

End the report with: *Handled any of these by phone outside WhatsApp? Tell me and I will drop them.* wazap sees WhatsApp calls and never cellular ones, so a call from the phone's own dialler leaves no trace here. Whatever the user answers is authoritative for the rest of the session: drop what they name and do not raise it again.

One line per item: who, what they want, how old. Include the `chat_id` only if the user is likely to act through another tool next. Offer to draft replies only for *Needs you* items; drafting and sending belong to the `whatsapp-send` skill.
