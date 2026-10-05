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

- **Start a trail.** Press **+** in the header. Give it a title, or just send the first
  question: the trail is created the moment you do. Back out with nothing and nothing
  is created.
- **Add entries.** Type and press Enter (Shift+Enter for a new line). Entries take
  Markdown (`**bold**`, `` `code` ``, lists, `>` quotes, fenced code blocks with a copy
  button) and TeX maths (`$x^2$` inline, `$$…$$` on its own lines). Paste or drop an
  image, or use the image button; anything you type goes with it as the caption. Tap an
  image to view it full-screen; tap again to zoom. With the box empty, the button on the
  right records a voice note.
- **Search.** The field above the list matches trail titles and entry text; entry hits
  show as snippets and open the trail at that entry.
- **Capture from any page.** Select text, right-click, then **Add to Question Trail**.
  It lands in the trail you last had open, with a link back to the page. Or press the
  🔗 button in the composer to attach the page you're reading to your next entry (send
  with an empty box and the page title becomes the entry).
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
  in. Nothing is sent until a second device has signed in too. At most two devices can
  be signed in at once; a third is offered the option to sign one of the others out.
- **Markers.** `○` only on this device · `◐` reached the relay · `●` on both devices.
  The status line totals them ("2 ○ to send · 1 ◐ in transit", or "All ●") and says
  so plainly if the relay is unreachable or paused. Click ↻ to sync now.

## Phone (Android)

The same app, hosted at <https://jain-arham-hsr.github.io/curiosity-pad/>.

1. Open that URL in Chrome on the phone. From the ⋮ menu choose **Add to Home screen**
   (or **Install app**).
2. Open it from the home screen and **Sign in** once.
3. On the first empty start, tap **Restore from Chrome extension on Mac** to pull
   everything the Mac has. Then open the side panel on the Mac; it sends on its next sync.
4. From any app, select text or a link, **Share → Curiosity Pad**. It lands in the trail
   you last had open. Images shared the same way arrive as image entries.

On the phone:

| Gesture | Does |
|---|---|
| Tap an entry | Select it: Reply, Edit and a ⋯ menu appear |
| Long-press | All actions: reply, nest, un-nest, move up/down, edit, copy, delete |
| Swipe right | Nest under the entry above |
| Swipe left | Un-nest |
| Pull down at the top | Sync |

The pill in the status line shows sync state (`○` to send · `◐` in transit · `●` synced);
tap it for details, Sync now, backup and sign in/out. The `?` on the trails list explains
all of this in the app.

Every push to `main` redeploys the site (`.github/workflows/pages.yml`). GitHub Pages
has to be switched on once: **Settings → Pages → Source: GitHub Actions**.

## Supabase setup (once)

1. Create a free project. In **SQL Editor**, run `supabase/schema.sql`, then
   `supabase/functions.sql` (re-run the latter after updates; it is idempotent).
2. **Authentication → Users → Add user** (auto-confirm). Then **Sign In / Providers →
   Email**: turn off *Allow new users to sign up*.
3. Put the project URL and publishable key in `extension/app/config.js`.
4. For password reset emails to work, set **Authentication → URL Configuration → Site
   URL** to `https://jain-arham-hsr.github.io/curiosity-pad/`. The reset link opens
   the phone app, which shows the new-password screen.

## Develop

```sh
npm test            # unit tests (Node 20+), no dependencies
npm run icons       # rebuild assets/*.svg and every PNG icon (needs Chrome installed)
```
