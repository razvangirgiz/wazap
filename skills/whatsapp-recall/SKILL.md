---
name: whatsapp-recall
description: Find something in the user's WhatsApp history. Use when they ask for an address, invoice, photo, document, link, phone number, date or a thing someone said or sent, or "what did X say about Y". Read-only.
---

# WhatsApp recall

Deliverable: the exact message or file, quoted with who sent it and when, or a clear "not found" that says where you looked.

## Narrow, then search

1. If a person or group is named, resolve it with `search_contacts` (people) or `list_chats` with `filter: "groups"` (groups) and search inside that `chat_id`. Searching one chat beats searching everything.
2. `search_messages` with the user's words. If nothing matches, run two more variants before giving up: a synonym or the other language the user writes in, and a narrower fragment (a street name instead of "the address", "factura" instead of "the invoice from March").
3. Media has no searchable text beyond its caption and the `[image]`/`[document] name.pdf` placeholder. For "the photo of…" or "the PDF", search the placeholder and filename words, or `read_messages` on the chat with `limit: 100` and scan `type` and `media.filename`.
4. Older than what is loaded: `read_messages` with `before` set to the oldest `message_id` you have, repeatedly, until the date the user remembers is covered or WhatsApp returns nothing more.

5. A voice note is searchable only once it has been transcribed; `search_messages`
   matches its `transcript` like any other text. If the chat holds notes whose text is
   still `[voice message · 0:42]`, call `transcribe_audio(message_id)` on the plausible
   ones before you conclude anything.

Done searching when you have a match, or all three query variants and the pagination step came back empty.

## Deliver

- A message: quote the text verbatim, then sender, chat, timestamp. Example: *"Str. Lunii 14, ap. 3, interfon 31" — Ana, 12 Mar 14:05.*
- A file or photo: `download_media` on the message, then open the saved file with your file-reading tool and answer from its contents when the user asked a question about it (an amount, a clause, a date). Give the saved path so the user can open it.
- A link: return the URL as sent; do not fetch it unless asked.
- Several candidates: list up to 5 with sender and date and ask which one, rather than guessing.
- Not found: say which chats and which phrases you tried, and whether `MEDIA_UNAVAILABLE` blocked a download (the sender must resend), or `TRANSCRIBE_UNAVAILABLE` left voice notes unread. Count those in one closing line rather than one per note: *4 voice notes in that chat are not transcribed. Turn it on with `wazap config transcribe`.*
