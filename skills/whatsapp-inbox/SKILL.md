---
name: whatsapp-inbox
description: Triage the user's WhatsApp. Use when they ask what they missed, what's unread, who is waiting on a reply, what needs attention today, or whom they forgot to answer. Read-only; it sends nothing and marks nothing read.
---

# WhatsApp inbox triage

Deliverable: a short, ranked list of what needs the user, with everything else compressed to one line. The user should finish reading in under a minute.

## Collect

1. `get_recent_messages` with the window the user implied (default 24h; "this week" = 168). If the result says `sync: "in_progress"`, wait 5 seconds and call it again once.
2. `list_chats` with `filter: "unread"` to catch chats whose activity predates the window.
3. For follow-ups ("whom did I forget"): in `list_chats` results, an individual chat whose `last_message.from_me` is false and older than 2 days is an unanswered conversation. Read its last 5 messages with `read_messages` to confirm something was actually asked.

Done collecting when every chat with unread messages appears in exactly one bucket below.

## Triage

Sort each chat into one bucket:

- **Needs you**: a direct question to the user, a request, a mention of the user in a group (`sender` is not the user and the text addresses them or quotes one of their messages), or money/dates/decisions awaiting them.
- **FYI**: information with no ask. Shipping updates, "ok thanks", group chatter that reached a conclusion.
- **Noise**: promotions, broadcast lists, groups the user is muted in (`muted_until` in the future), forwards without a question.

Rank *Needs you* by: people over groups, older unanswered over newer, money and deadlines first.

## Report

```
Needs you (3)
1. Ana — asks if Thursday 10:00 works for the notary. 5h ago.
2. Bloc 12 group — Mihai needs your vote on the roof quote by Friday. 1d ago.
3. Dan — sent the contract PDF, waiting for your comments. 2d ago.

FYI: Curier (delivered), Mama (photos), Team (retro moved to Tuesday).
Noise: 4 promo chats.
```

One line per item: who, what they want, how old. Include the `chat_id` only if the user is likely to act through another tool next. Offer to draft replies only for *Needs you* items; drafting and sending belong to the `whatsapp-send` skill.
