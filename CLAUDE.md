# Curiosity Pad — design record

> Named after Arham's original "Curiosity". Each item is a **Question Trail**.

This file records *why* the app is shaped the way it is. Read it before changing
anything structural.

---

## 1. The problem it solves

Arham's notetaking is curation: search a question, read several sources, copy the
sentences that land, stitch them into one satisfying answer. Doing that by hand (his
"version 1") was the approach that worked best. Every attempt to have an LLM write or
arrange the notes failed (see `~/Workbench/Greenfield/CLAUDE.md` for that history).

The real bottleneck was never the writing. **Answering one question means answering
several others first, and by the time he understood the thing, he had forgotten the
path he took.** So he no longer knew what to note down.

Curiosity Pad records that path as it happens. **The trail is the outline.** Read
bottom-up, the sub-questions are the prerequisites, in the order the note should
present them. Writing the actual note stays manual, in Typst, as before.

## 2. Principles (firm)

- **Specific and minimal.** No tags, no search, no AI, no transcription. Add a feature
  only when its absence actually hurts.
- **Content can't change once sent; structure always can.** A sent entry changes only
  through an explicit Edit, which shows "edited". Where an entry sits (order, nesting)
  can be changed freely at any time. In data terms: `body`/`caption` are edited
  rarely and visibly; `parentId`/`pos` change freely.
- **A WhatsApp-like feel:** an input box, voice notes, images with captions. But unlike
  WhatsApp: many separate trails, and entries can be reordered and nested.
- **No background services.** Nothing scheduled, nothing always running.
- **Nothing fails silently.** The user can always see whether their data has arrived.

## 3. Shape

```
Phone PWA (full offline copy) ──▶ Supabase (relay only) ◀── Chrome extension (full offline copy)
                                                                   │ on open
                                                                   ▼
                                                         Mac folder: Curiosity Pad/
```

- **Chrome extension.** A side panel holding the whole app, and right-click "Add to
  Question Trail" for selected text. The page URL and title are attached automatically,
  so captures from an LLM chat link back to that conversation.
- **Android PWA.** The same web UI, installed from Chrome, capturing through the share
  sheet. Hosted for free on GitHub Pages.
- **One UI codebase** serves both. Only `platform.js` and `backup.js` are
  extension-specific.

### Sync (built in step 2)

- **Both devices keep full copies. Supabase is only a relay.** Changes and media wait
  there until the other device confirms it has them, then they are deleted. Supabase
  stays near empty, so its free limits (1 GB files) never matter.
- **Pull before push.** `sync.js` always receives first. If receiving fails (no
  network, Supabase paused), **nothing is sent**; local changes stay queued. Capturing
  is never blocked.
- **Alone mode.** Until a second device has signed in, nothing is pushed: an op's
  `pending_for` would be empty and the relay would drop it unread. Status says "Sign
  in on your phone to start syncing".
- **Conflicts.** Content never changes silently, so the only real conflict is two
  devices moving the same entry while offline. `store.applyRemote()` applies incoming
  ops, then replays this device's queued moves/edits on top, in order. An entry whose
  parent was deleted on the other device surfaces at the end of the top level with a
  flag ("The entry this was nested under was deleted…"), and its queued op is rewritten
  to match, so both devices end up identical. A queued edit/move of an entry that no
  longer exists is dropped and reported in the status line.
- **Trail markers** (not ticks) show how far each entry has travelled:
  `○` this device only · `◐` reached the relay · `●` on both devices.
  `node.op` is the id of the node's latest content op (create or edit). Pushing that
  op sets `◐`; a receipt for it (left by the other device's `ack_ops`) sets `●`. Moves
  don't get per-entry markers; they count towards "to send" in the status line. With
  more than two devices, the first receipt sets `●`; refine if that ever matters.
- **Relay schema** (`supabase/schema.sql`, `functions.sql`): `devices`, `ops`
  (`pending_for uuid[]`), `receipts`, storage bucket `media`. `ack_ops(ids, device)`
  leaves receipts, removes the device from `pending_for`, deletes fully-delivered ops
  and returns their ids so the caller deletes the media. RLS limits everything to the
  signed-in user; there is exactly one user and signups are disabled.
- **Auth.** One Supabase email/password user. The session (refresh token) lives in
  IndexedDB, so each device signs in once. Password reset emails link to the hosted
  PWA (`#type=recovery`), which shows the new-password screen; the link cannot land
  on a `chrome-extension://` page.
- **Supabase pauses free projects after 7 idle days.** Any use counts as activity. If
  it does pause (HTTP 540), nothing is lost; the status line says "Relay is paused.
  Restore it in Supabase." with a Retry.
- **When sync runs:** on panel open, 1.5 s after a local change, on becoming visible,
  every 60 s while visible, and on clicking ↻. Nothing runs in the background.
- **Recovery (step 3).** If one device loses its data, it restores from the other
  through the relay, in batches deleted as they're collected. The Mac can also restore
  from the backup folder. Only `○` entries on the device that lost its data can be
  lost. The phone requests persistent storage so Chrome does not clear it on its own.

### Backup (built)

Every time the side panel opens, the extension writes every trail into a folder the
user chose once:

```
<folder>/<trail-slug>--<id8>/trail.md     readable indented outline
                            trail.json   complete data, enough to rebuild from
                            media/<entry-id>.<ext>
```

Text files are only rewritten when they change. Media is written once, since it never
changes. Only folders matching `--<8 hex>` are ever removed, and only when their trail
no longer exists. Chrome may ask for permission again after a restart; that is one
click ("Allow backup") in the status line.

## 4. Rejected, and why

- **Telegram (topics group + replies):** no reordering or nesting, and not
  purpose-built.
- **Supabase as the permanent store:** 1 GB file storage fills in about a year of
  voice notes and images. Used as a relay instead.
- **Mac as the server, reached through Tailscale:** Tailscale is a third party (it
  sees metadata, though not content). Plain WireGuard needs a public IP.
- **Cloudflare R2:** asks for a card. Durable Objects (free, no card, 5 GB) would also
  work, but the user chose Supabase as the simpler option.
- **Firebase:** file storage needs the paid plan since Feb 2026. Media would have to
  be split into the database.
- **Capacitor/native Android:** only worth it without any hosting. Since hosting is
  free, the PWA is simpler and updates itself. Wrap with Capacitor later only if the
  PWA falls short.
- **A scheduled backup daemon:** the user doesn't want background services. Backing
  up when the panel opens replaces it.

## 5. Code map

No build step and no runtime dependencies. Plain ES modules. Load `extension/` in
Chrome directly.

```
extension/
  manifest.json      MV3; side panel, context menus, unlimitedStorage
  background.js      service worker: toolbar → side panel; right-click capture
  sidepanel.html     the app shell
  mic.html, mic.js   one-time microphone permission (Chrome can't prompt in a side panel)
  app/
    main.js          UI: trails list, trail view, composer, status line
    store.js         every change is an op: applied locally + appended to the outbox;
                     applyRemote() for the other device's ops; markers
    sync.js          pull → ack → push → receipts, through the relay
    supabase.js      thin fetch client: auth (with silent refresh), PostgREST, storage
    config.js        project URL + publishable key (public by design)
    db.js            IndexedDB: trails, nodes, media, outbox, meta
    tree.js          pure: ordering, nesting, drag/drop placement, delete-promotion
    export.js        pure: trail → markdown / json, file naming
    backup.js        File System Access mirror into the chosen folder
    media.js         image compression (WebP ≤1600px), Opus voice recording at 24 kbps
    platform.js      the only extension-specific calls the UI makes
    util.js          ids, slugs, time formatting
tests/               node --test (pure modules only)
scripts/make-icons.mjs   draws the ◐ toolbar icon with no dependencies
```

### Data

- **Trail** `{ id, title, created, updated }`. The title is the root question.
- **Node** `{ id, trailId, parentId, pos, kind: text|image|audio, body, caption,
  mediaId, mime, duration, source: {url,title}|null, created, edited, sync }`.
- **Ordering:** siblings are sorted by `pos` (a float). A position between two
  neighbours is their midpoint. Deleting an entry keeps its replies; they move up into
  its slot.
- **Outbox:** every op (`trail.create/rename/delete`, `node.create/move/edit/delete`),
  stamped with id, time and device. It is written in the same transaction as the
  change itself. Step 2 drains it to the relay. Until then it only grows; it holds
  small JSON only, never media blobs.

## 6. Build order

1. **Chrome extension, local only, plus backup-on-open.** ← built
2. **Supabase relay, sync, trail markers live, status line counts and warnings.** ← built
3. Android PWA (public repo, GitHub Pages), share-sheet capture, persistent storage,
   password-reset landing, restore-from-other-device.

## 7. Testing

- `npm test` runs the unit tests for `tree.js` and `export.js`.
- The UI was smoke-tested in real Chrome (154) through puppeteer-core, kept outside
  the repo: create a trail, send, nest (Tab), reply, edit (⌘↩), image, delete with
  replies promoted, capture, backup to disk, outbox contents. All passed with no
  console errors.
- Sync was tested with two separate Chrome profiles against a mock relay (a Node
  server implementing the same endpoints and `ack_ops` semantics, also kept outside
  the repo): alone mode, push/ack/receipts and marker transitions, media upload,
  delivery and deletion, pull-before-push under a paused relay, and the
  nest-vs-delete conflict ending identical on both devices.
- **Not yet checked by hand:** the right-click menu itself, the real folder picker and
  whether Chrome remembers its permission, the mic permission tab, drag-and-drop with
  a mouse, and sync against the real Supabase project (the author never had the
  user's password).
