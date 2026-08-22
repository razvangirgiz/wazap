---
name: whatsapp-groups
description: Catch up on a busy WhatsApp group. Use when the user asks what happened in a group, what was decided, what they are being asked to do there, or for a summary of a thread with many messages. Read-only.
---

# WhatsApp group catch-up

Deliverable: decisions, dates, and what is asked of the user, in that order, with the chatter gone. A 300-message thread should compress to a screen.

## Load the whole window

1. Resolve the group with `list_chats` `filter: "groups"` (match on name; ask if two match). `get_group_info` once for the participant names and who the admins are; use names, not numbers, in the summary.
2. `read_messages` with `limit: 200`. If the oldest message is still inside the window the user asked for, call again with `before` set to that oldest `message_id`, until the window is covered. Done loading when the oldest message you hold is older than the window, or WhatsApp returns no more.
3. Note which messages quote or mention the user: `quoted.sender` equal to the user, the user's name in `text`, or `sender` addressing them directly. These are the **asks**.

## Extract

Work through the messages once and collect:

- **Decisions**: something agreed or announced by an admin or by the people it concerns ("ok, Saturday at 10 then").
- **Dates and deadlines**: any concrete day, time, or "by Friday", with what it is for.
- **Asks of the user**: every mention or reply to them, plus open questions nobody answered that fall on the user.
- **Open threads**: questions still without an answer, for anyone.
- **Polls**: the question and options (`[poll] …`); wazap cannot read votes, so say that if the user asks who voted.

Skip greetings, reactions, stickers, and messages that only acknowledge.

## Report

```
Bloc 12 — 312 messages since Monday

Decided
- Roof repair goes to Tehnoplast, 18,400 lei, vote closed Wednesday.
- Water off Thursday 09:00–13:00.

Dates
- Fri 15 Mar: pay share (1,150 lei) to the association account.

You
- Mihai asked (Tue) if you can be home Thursday for the plumber. Unanswered.

Open
- Nobody confirmed who holds the basement key.
```

End with the message count and the window covered, so the user knows what the summary stands on. Replying in the group is the `whatsapp-send` skill's job; here, offer it only for the *You* items.
