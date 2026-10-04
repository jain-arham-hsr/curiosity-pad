# Curiosity Pad

Keep track of your **Question Trails**: the chain of smaller questions you had to answer
before the big one made sense. Capture them as they come up, nest them, and use the trail
as the outline when you write the note.

A Chrome extension that keeps everything on this computer, backs it up to a folder,
and syncs with your phone through a Supabase relay. The phone app is step 3. See
`CLAUDE.md` for the full design.

## Install (about a minute)

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick the `extension/` folder.
3. Pin Curiosity Pad from the puzzle-piece menu, then click its icon. The side panel opens.

After changing any code, click the reload arrow on the extension's card.

## Use

- **Start a trail.** Type the question you're chasing and press Enter.
- **Add entries.** Type and press Enter (Shift+Enter for a new line). Paste or drop an
  image, or use the image button; anything you type goes with it as the caption. With
  the box empty, the button on the right records a voice note.
- **Capture from any page.** Select text, right-click, then **Add to Question Trail**.
  It lands in the trail you last had open, with a link back to the page.
- **Shape the trail.** Click an entry to select it, then:

  | Key | Does |
  |---|---|
  | Tab / Shift+Tab | Nest under the entry above / un-nest |
  | Alt+↑ / Alt+↓ | Move up / down |
  | ↑ / ↓ | Select previous / next |
  | R | Reply: the next thing you send goes under this entry |
  | E | Edit (⌘↩ saves). The entry shows "edited". |
  | Delete | Delete (asks first). Its replies move up a level. |

  Or drag an entry: drop it on the top or bottom edge of another to place it before or
  after, or on the middle to nest it inside.
- **Backup.** Click **Choose backup folder** in the status line once. From then on,
  every time the panel opens, each trail is written there as `trail.md` (a readable
  outline), `trail.json` and `media/`. If Chrome asks again after a restart, click
  **Allow backup**.
- **Sync.** Once per device, tap **Sign in** in the status line. The app stays signed
  in. Nothing is sent until a second device has signed in too.
- **Markers.** `○` only on this device · `◐` reached the relay · `●` on both devices.
  The status line totals them ("2 ○ to send · 1 ◐ in transit", or "All ●") and says
  so plainly if the relay is unreachable or paused. Click ↻ to sync now.

## Supabase setup (once)

1. Create a free project. In **SQL Editor**, run `supabase/schema.sql`, then
   `supabase/functions.sql`.
2. **Authentication → Users → Add user** (auto-confirm). Then **Sign In / Providers →
   Email**: turn off *Allow new users to sign up*.
3. Put the project URL and publishable key in `extension/app/config.js`.
4. For password reset emails to work, set **Authentication → URL Configuration → Site
   URL** to the hosted phone app (step 3).

## Develop

```sh
npm test            # unit tests (Node 20+), no dependencies
npm run icons       # redraw the toolbar icons
```
