---
name: whatsapp-send
description: Send, reply, forward, share a file, react, or create a poll on WhatsApp on the user's behalf. Use for any request that results in an outgoing WhatsApp message. Drafts first and sends after the user approves; messages leave from the user's own account and cannot be unsent.
---

# WhatsApp send

## Account selection

Call `list_accounts` first. With multiple profiles, pass the chosen `account_id` to every account operation below, including `get_status` and `link_account`. Preserve `(account_id, chat_id/message_id)` from results; matching names or IDs across accounts do not make them interchangeable. Show the sending account in every draft and pass its exact `draft_id` to `confirm_send`.

For an explicitly combined inbox, `search_messages`, `get_recent_messages` and `get_unanswered` accept `account_ids` or `all_accounts: true`. Keep account labels in the summary. Follow each pagination cursor unchanged; an unavailable account makes results partial, never proof of absence. Other tools remain per account. Account additions require new OAuth consent.


A message sent here is indistinguishable from one the user typed. The rail: **the user sees recipient and exact text, says yes, then it goes.** One approval covers one message to one chat.

## Resolve the recipient

1. `search_contacts` with the name. Exactly one match: use its `contact_id` as the destination `chat_id`. Several: list them with numbers and ask. None: ask for the number in international format; `NOT_ON_WHATSAPP` means the number is wrong, not that you should retry.
2. Groups come from `list_chats` with `filter: "groups"`. Before posting, `get_group_info`; if `announcement_only` is true and the user is not admin, say so instead of trying.
3. A reply to a specific message needs its `message_id` from `read_messages`; pass it as `reply_to` so the quote shows.

## Draft

1. `read_messages` on the chat, `limit: 20`, and match the register already in use: language (Romanian or English), formality, emoji, length. A two-line chat gets a two-line reply.
2. Write the message as the user, first person, without a signature or "sent by an assistant".
3. Files: `send_media` needs a local `file_path` that exists on the machine running wazap, or a public URL. A ChatGPT upload or sandbox path is not automatically available on the Wazap host. HTTP local files must be inside the configured export directory. Do not invent a path or a public upload URL. Check the path before drafting; pick `as_document: true` for PDFs and anything the recipient should keep at original quality, `as_voice: true` only for audio meant as a voice note, `as_gif: true` for a .gif or an mp4 meant to loop like a GIF (a .gif needs ffmpeg on that machine).
4. Call the matching send tool (`send_message` / `send_media` / `send_poll` / `send_location` / `forward_message`). It does **not** send. It returns a `draft_id` and a `preview`.

## Confirm, then send

Show the preview the tool returned, exactly, and wait for a yes:

```
Account: Business
To: Ana (+40 722 …)
"Joi la 10 e perfect, ne vedem la notar. Aduc eu actele."
```

On the user's yes, call `confirm_send` with that `draft_id`. Do not call the send tool again. Report the result with the `message_id` so the user can follow up with `edit_message` (own messages, 15 minutes) or `delete_message`. `DRAFT_EXPIRED` (15 minutes) or `DRAFT_NOT_FOUND` means draft again, show the new preview, and wait for another yes.

Approval is per message, even after "just send it" for a batch, when the recipient is a group, a number not in the user's contacts, or the content contains money, dates, or commitments. For a batch of plain messages the user already approved as a list, `confirm_send` them one by one and stop at the first error; `RATE_LIMITED` means wait the seconds in `fix`, then continue.

## Out of scope

`delete_message` with `for_everyone` and `manage_group` remove/leave run only on an explicit ask naming the message or person. Bulk sends to people who did not write first are the user's account at risk of a WhatsApp ban; say that once and let them decide.

### Uncertain delivery

`SEND_OUTCOME_UNKNOWN` means a message may already have been sent. Do not confirm
again expecting a retry, or create another draft automatically. Read the chat and
ask the user what to do. A successful confirmation can be repeated to retrieve
its existing receipt. The client must still obtain explicit human approval.
