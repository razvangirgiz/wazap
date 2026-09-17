---
name: whatsapp-send
description: Send, reply, forward, share a file, react, create a poll, or change the linked account's profile picture on WhatsApp on the user's behalf. Use for any request that results in an outgoing WhatsApp message or a new profile photo. Find who the user means with find_contact first; messages draft first, and a profile picture has no draft. Show the image, wait for a yes, then call set_profile_picture (manage_group set_picture for a group).
---

# WhatsApp send

A message sent here is indistinguishable from one the user typed. The rail: **the user sees recipient and exact text, says yes, then it goes.** One approval covers one message to one chat.

## Which account

If more than one WhatsApp account is linked, call `list_accounts` first and pass `account_id` on every tool in this flow, including `confirm_send`. A send to a chat no account knows, with two or more accounts, fails `AMBIGUOUS_ACCOUNT`; do not retry without `account_id`. A chat only one account knows selects that account.

## Resolve the recipient

1. `find_contact` with what the user called them, as said: a name ("Ana"), a nickname ("Mișu"), a relationship ("mamei"), a group ("fotbal"). Put what tells people apart in `qualifier` ("contabilitate" for "Ana de la contabilitate"). Without `account_id` it searches every account.
   - `resolved`: use `contact.chat_id`, and `contact.account_id` on every tool that follows.
   - `ambiguous`: never pick. Ask, naming each candidate by what tells them apart (the last exchange and when, groups in common, note, tags, the number's last four digits), then call `find_contact` again with the full name, a qualifier, or those four digits as `qualifier`. Candidates on different accounts: ask which account too.
   - `not_found`: ask. For a relationship ("mama"), ask who it is, find that person, then file it with `update_contact_details` (`fields: {"relatie": "mama"}`) so it resolves next time. A number the user gives goes straight in `chat_id`, in international format; `NOT_ON_WHATSAPP` means the number is wrong, not that you should retry.
2. When the user names a number that is not in contacts yet, `save_contact` puts it in the account's WhatsApp contacts so it reads as a name next time; `remove_contact` drops an entry. A batch the user describes by a label ("all suppliers", "the team") is everyone under that tag: `search_contacts` with `tag`.
3. Before posting in a group, `get_group_info`; if `announcement_only` is true and the user is not admin, say so instead of trying.
4. A reply to a specific message needs its `message_id` from `read_messages`; pass it as `reply_to` so the quote shows.

## Draft

1. Match the register already in use: language (Romanian or English), diacritics or none, tu or dumneavoastră, emoji, length. A resolved `find_contact` carries it in `context`: `context.style` is how the user writes there, `context.recent` the last messages both ways. Without `context` (a read session, a contact tagged `#private`, an account that turned it off), use `read_messages` on the chat, `limit: 20`, when you need the thread. A two-line chat gets a two-line reply.
2. Write the message as the user, first person, without a signature or "sent by an assistant". Words the user dictated ("send exactly: …") go out as dictated.
3. Files: `send_media` needs a local `file_path` that exists on the machine running wazap, or a public URL. Check the path before drafting; pick `as_document: true` for PDFs and anything the recipient should keep at original quality, `as_voice: true` only for audio meant as a voice note, `as_gif: true` for a .gif or an mp4 meant to loop like a GIF (a .gif needs ffmpeg on that machine).
4. To @-mention someone, pass their ids as `mention_ids` and write `@<number>` in the text where the mention belongs. A mention the text lacks gets its `@<number>` added at the end, and the preview shows the final text.
5. Call the matching send tool (`send_message` / `send_media` / `send_poll` / `send_location` / `forward_message`). It does **not** send. It returns a `draft_id` and a `preview`.
6. A `send_message` draft may come back with `style_check.warnings`: `language_mismatch`, `diacritics_mismatch`, `address_mismatch`, `length_outlier`. Unless the user dictated the words, fix what it names and draft again, then show only the draft that reads like the user. It never blocks a send.

## Confirm, then send

Show the preview the tool returned, exactly, and wait for a yes:

```
To: Ana (+40 722 …)
"Joi la 10 e perfect, ne vedem la notar. Aduc eu actele."
```

A draft "Vă anunț că ajung la 7." to someone the user writes to on tu and without diacritics comes back with `address_mismatch` and `diacritics_mismatch`: draft "ajung la 7, nu mai gati" instead, and show that preview.

On the user's yes, call `confirm_send` with that `draft_id`. Do not call the send tool again. Report the result with the `message_id` so the user can follow up with `edit_message` (own messages, 15 minutes) or `delete_message`. `DRAFT_EXPIRED` (15 minutes) or `DRAFT_NOT_FOUND` means draft again, show the new preview, and wait for another yes. `SEND_OUTCOME_UNKNOWN` means the message may have gone out: do not confirm or draft it again; check the chat with `read_messages` and tell the user what you find.

`SEND_BLOCKED` means the account's send rules refuse the recipient (an allowlist or a deny list the owner set with `wazap config send`). It can fire at draft time or at `confirm_send`. Do not retry or route around it — tell the user which rule fired; only they can lift it.

Approval is per message, even after "just send it" for a batch, when the recipient is a group, a number not in the user's contacts, or the content contains money, dates, or commitments. For a batch of plain messages the user already approved as a list, `confirm_send` them one by one and stop at the first error; `RATE_LIMITED` means wait the seconds in `fix`, then continue.

## Profile picture

`set_profile_picture` changes the linked account's photo; `manage_group` with `action: "set_picture"` changes a group's, and `action: "remove_picture"` takes a group's down (both need admin rights). None of them is a chat message and there is no draft: every contact or member sees the change at once. Show the image (`file_path` or `url`) and wait for a yes, then call it. JPEG, PNG or WebP only, at most 10 MB. `set_profile_picture` does not remove the account's own photo.

## Out of scope

`delete_message` with `for_everyone` and `manage_group` remove/leave run only on an explicit ask naming the message or person. `delete_message` takes someone else's message for everyone only in a group where the linked account is an admin; with `for_everyone: false` it deletes any message for the linked account alone, and nobody else sees a change. `manage_chat` with `action: "clear"`, `"delete"` (both for the linked account only), `"block"`, or `"pin_message"` (every member sees the pin) hits WhatsApp at once: say what will change and wait for a yes. `join_group` without `confirm: true` only previews the group; show that preview and call it again with `confirm: true` after a yes. The same holds for group administration: `manage_group` with `action: "approve_join_requests"` or `"reject_join_requests"` (ids from `"list_join_requests"`), and the settings `"set_announcement_only"`, `"set_info_locked"`, `"set_add_mode"`, `"set_join_approval"` and `"set_disappearing"`, change the group for every member at once. Say what will change and wait for a yes. Bulk sends to people who did not write first are the user's account at risk of a WhatsApp ban; say that once and let them decide.
