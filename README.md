# Omagif

A GIF picker for the [Omarchy](https://omarchy.org/) shell. Hit a key, type a
search, arrow around an animated grid, press Enter — the GIF is on your
clipboard, ready to paste into Slack, Discord, Signal, or anywhere else that
takes an image.

![Omagif](preview.png)

It's built the same way as Omarchy's own emoji picker: a Quickshell overlay
running inside the long-lived `omarchy-shell` process, themed from the same
`[menu]` tokens, so it looks like the rest of your desktop and opens instantly.

## Requirements

- Omarchy 4.x (the manifest-based shell plugin system)
- `curl`, `wl-clipboard`, `wtype`, `python3` — all present on a stock Omarchy
- Optionally, a free API key from [Giphy](https://developers.giphy.com/dashboard/) —
  there is a no-key option, with [trade-offs](#searching-without-an-api-key)

## Install

```bash
omarchy plugin add https://github.com/stoneynutcase/omagif --enable
```

That's the whole install. The first time you open the picker it shows a
first-run screen with a **Set up** button per available service, which opens
the setup flow in a floating terminal.

You can run the same flow from a terminal yourself:

```bash
~/.config/omarchy/plugins/stoneynutcase.omagif/setup                    # asks, if there's a choice
~/.config/omarchy/plugins/stoneynutcase.omagif/setup --provider giphy          # straight to one
~/.config/omarchy/plugins/stoneynutcase.omagif/setup --provider giphy-keyless  # no key at all
```

Setup checks the dependencies, opens the page where you get a key, verifies
the key you paste against the live API before saving it, writes
`~/.config/omagif/config.json`, and then offers to enable the plugin, link
the `omagif` command into `~/.local/bin`, and add the keybinding. Everything
after the key is asked for, not assumed. Run it again any time to change
services or replace a key — or press `Ctrl+,` inside the picker.

### Searching without an API key

Setup offers **Giphy (no API key)** alongside the regular Giphy provider. It
needs no sign-up and nothing to paste — pick it and search.

It works by reading Giphy's public search page rather than its API, because the
API authenticates every request and the old public beta key (`dc6zaTOxFJmzC`)
now answers `403 BANNED`. giphy.com renders its result grid server-side, one
anchor per GIF carrying the id, the share link, the tile's aspect ratio and a
title, which is enough to build the same picker. Only the ids are reused: the
media URLs in that markup embed a `cid` scoped to the request that produced
them and `403` for anyone you send them to, so links are rebuilt from the id
and stay shareable.

What you give up against a key:

| | With a Giphy key | No key |
|---|---|---|
| Results per search | 40, scroll for more | ~25, no second page |
| Rating / language filter | `rating`, `lang` | whatever the page decides |
| Stability | a versioned API | scraped markup — a redesign breaks it |

The failure mode is worth knowing: if Giphy changes that page, every search
starts reporting no results. The picker says as much when it finds nothing, and
adding a key switches you to the full provider. With both configured, `Ctrl+P`
flips between them.

### Providers

Giphy is the only service offered today, keyed or keyless. **Tenor is present
but disabled**:
Google stopped accepting new Tenor API clients in January 2026, so a fresh
install has no way to obtain a key. Its `v2` endpoint still serves *existing*
keys — it validates them and answers normally — so the module is kept intact
and anyone who already holds a Tenor key can still select it and use it. If
signups reopen, flipping `enabled` in `providers/index.json` brings it back
with no other change.

Providers are pluggable rather than hardcoded. Each one is a self-contained
module in `providers/<Name>.js` plus an entry in `providers/index.json`, which
is the single catalogue that the picker, `./setup` and `omagif doctor` all
read — so a provider's key URL and sign-up status are stated exactly once.
Adding one is a module, one `.import`, and a JSON entry;
see [`providers/README.md`](providers/README.md).

With two providers configured, `Ctrl+P` switches between them for the session.

### Keybinding

`setup` offers to add this for you. To do it by hand, put it in
`~/.config/hypr/bindings.lua` — it sits naturally next to the emoji picker on
`SUPER + PERIOD`:

```lua
o.bind("SUPER + SHIFT + PERIOD", "GIF picker", "omarchy-shell shell toggle stoneynutcase.omagif")
```

## Removing it

```bash
omarchy plugin remove stoneynutcase.omagif
```

That takes the plugin directory and nothing else. Everything setup asked
permission to create lives outside it, and none of it is reached by removing
the plugin:

```bash
rm -rf ~/.config/omagif                             # config — including your API key
rm -rf ~/.cache/omagif ~/.local/state/omagif        # cached GIFs, search history, log
rm -f  ~/.local/bin/omagif                          # the CLI symlink
rm -f  ~/.local/share/applications/omagif.desktop   # the desktop entry
```

The keybinding is the one that isn't a file of ours: `setup` appended it to
`~/.config/hypr/bindings.lua` under an `-- Omagif GIF picker` comment, so
delete that comment and the `o.bind` line under it.

GIFs you saved with `Ctrl+S` are left where they are, in `~/Pictures/gifs`.
Removing a picker shouldn't take your pictures with it.

## Keys

| Key | Action |
| --- | --- |
| type | search (debounced; empty search shows what's trending) |
| `Tab` | select the whole query, so the next keystroke replaces it |
| `Ctrl+Up` / `Ctrl+Down` | walk back and forward through past searches |
| `Ctrl+Delete` | forget every remembered search |
| `←` `→` `↑` `↓` | move around the grid |
| `PgUp` `PgDn` `Home` `End` | move by a screenful, or jump to either end |
| `Enter` | whatever `enterAction` says — copy the GIF as a **file** by default |
| `Shift+Enter` | copy the GIF's share link as text |
| `Ctrl+Enter` | paste that link straight into the window underneath |
| `Alt+Enter` | copy the GIF's raw bytes as `image/gif` |
| `Ctrl+S` | save the GIF to `~/Pictures/gifs` |
| `Ctrl+O` | open the GIF's page in your browser |
| `Ctrl+P` | switch provider for this session (needs two that can search) |
| `Ctrl+,` | reopen setup in a terminal to change service or key |
| `Backspace` / `Ctrl+U` | delete a character / clear the search (wipes the whole query when it's selected) |
| `Esc` | clear the search, then close |

The mouse works too: left-click does the `Enter` action, middle-click copies
the link, right-click opens the page.

### Why the default is the file

`wl-copy -t` **overrides** the MIME type rather than adding one, so the
clipboard carries exactly one payload at a time. That makes the choice matter,
and the three differ in where they survive:

| Payload | Clipboard type | Reality |
| --- | --- | --- |
| **File** (`Enter`) | `text/uri-list` | the receiving app attaches the actual GIF — animation intact. The default, and what works in Signal |
| **Link** (`Shift+Enter`) | `text/plain` | depends on the far end fetching and unfurling the URL; some preview fetchers refuse it |
| **GIF** (`Alt+Enter`) | `image/gif` | rarely pastes at all — apps ask the clipboard for `image/png`, so raw GIF bytes are never requested |

That last row is worth knowing about, because it looks like a bug: Omarchy's
own clipboard manager watches `text` and `image/png` and nothing else.
`image/gif` isn't part of the desktop's image convention, and converting to
PNG to satisfy it would throw away the animation — which rather defeats a GIF
picker.

The file is copied under a readable name taken from the GIF's title
(`suspicious-monkey.gif`), not the SHA-1 the cache stores it under, so the
attachment doesn't arrive called `c048132247cd….gif`.

### Which link gets copied

Not the URL the search returned. That one is ~250 characters with a
`v1.<base64>` segment carrying the `cid` of the API request that produced it —
fine for downloading, poor for handing to another person, and a shape that
link-preview fetchers sometimes refuse.

`linkStyle` picks what a copied link points at instead:

- `page` (default) — the canonical share link, `giphy.com/gifs/…`. What the
  service intends for sharing, and what chat apps unfurl into a playing GIF.
- `direct` — a short permalink to the bytes, `i.giphy.com/<id>.gif`. Renders
  inline in Discord and Slack rather than as a link card.

Each provider module decides its own `direct` form, in `shortDirectUrl()`.

Downloads (`Enter` as `image`/`file`, and `Ctrl+S`) always use the original
search URL, which is the rendition already chosen and which `curl` fetches
without complaint.

Change the default with `enterAction` — `"link"`, `"paste"`, `"file"`, or
`"image"`. The modifier variants always work regardless:

```json
{ "enterAction": "paste" }
```

## Configuration

`~/.config/omagif/config.json`, hot-reloaded on save:

```json
{
  "provider": "giphy",
  "giphy": { "apiKey": "…", "rating": "pg-13", "lang": "en" },
  "limit": 40,
  "columns": 4,
  "cacheDir": "~/.cache/omagif",
  "saveDir": "~/Pictures/gifs"
}
```

Settings live in their own directory rather than in
`~/.config/omarchy/shell.json`, which is where Omarchy's first-party widgets
keep theirs. Two reasons: `~/.config/omarchy/` belongs to Omarchy itself, and
`shell.json` is mode 644, gets pasted into bug reports, shared as dotfiles, and
rewritten wholesale by `omarchy refresh shell` — no place for an API key. This
file is written mode 600 and is ours alone.

| Key | Meaning |
| --- | --- |
| `provider` | which service to search; ids come from `providers/index.json` |
| `<provider>.apiKey` | your key; the picker says so plainly when it's missing |
| `giphy.rating` | `g`, `pg`, `pg-13`, `r` |
| `enterAction` | what `Enter` and left-click do: `file`, `link`, `paste`, or `image` |
| `linkStyle` | `page` for the share link, `direct` for a short `.gif` URL |
| `historyLimit` | searches to remember (default 50; `0` records none) |
| `pasteKey` | auto-paste keystroke: `ctrl+v`, `shift+insert`, `ctrl+shift+v` (terminals) |
| `pasteDelayMs` | wait before that keystroke, so focus is back on your app (default 300) |
| `limit` | results per page, capped at 50 |
| `columns` | grid columns, 2–8; cell size follows from the card width |
| `cacheDir` | where downloaded GIFs are kept, content-addressed by URL |
| `saveDir` | where `Ctrl+S` puts GIFs |

`omagif doctor` checks the dependencies, the config, and whether the shell has
actually discovered the plugin.

### Search history

Searches are remembered in `~/.local/state/omagif/history.json`, most recent
first. `Ctrl+Up` walks back through them and `Ctrl+Down` forward; going forward
past the newest puts back whatever you had been typing. The status line on the
right shows `history 3/12` while you're walking, and the plain arrow keys stay
with the grid throughout.

A query is recorded when the picker **closes**, not on every keystroke —
otherwise every prefix of every word (`m`, `mo`, `mon`, `monk`) would end up in
there. Searches that returned nothing aren't kept either. Entries are
deduplicated, and re-running an old search moves it back to the top.

`Ctrl+Delete` forgets the lot from inside the picker, confirming in the status
line. There's no undo, so it's deliberately a two-key gesture rather than
sharing plain `Delete`, which wipes a selected query instead. From a terminal:

```bash
omagif history          # list what's remembered
omagif history clear    # forget all of it
```

Set `historyLimit` to cap it (default 50), or to `0` to record nothing at all:

```json
{ "historyLimit": 0 }
```

### When auto-paste doesn't land

`Ctrl+Enter` copies the link and then synthesises a keystroke. Two things can
go wrong, and both are tunable:

- **Focus timing.** The overlay holds *exclusive* keyboard focus, and the
  compositor hands focus back asynchronously after it closes. A keystroke sent
  too early lands nowhere. Raise `pasteDelayMs` if your machine is slower than
  the 300 ms default.
- **The keystroke itself.** `ctrl+v` suits Electron and GTK apps; a terminal
  wants `ctrl+shift+v`.

The link is left on the clipboard either way, so a missed paste is still one
`Ctrl+V` away — and you get a notification saying so. Actions log to
`~/.local/state/omagif/omagif.log`, including `wtype`'s own stderr, so a
silent failure leaves a trace:

```bash
tail ~/.local/state/omagif/omagif.log
```

## How it works

- `Omagif.qml` is the overlay: a layer-shell window on the overlay layer with
  exclusive keyboard focus, holding a `GridView` of `AnimatedImage`s.
- `Providers.js` turns `(config, query, cursor)` into one URL and the JSON that
  comes back into a flat `{ id, title, previewUrl, gifUrl, pageUrl }` shape.
  Adding a service means one branch in `searchUrl()` and one in `parse()`.
- Searching is one `curl` at a time. A keystroke arriving mid-flight queues a
  single follow-up rather than racing a pile of requests, so fast typing costs
  one extra round trip. Scrolling to the last row pages in the next set through
  the same lane.
- Thumbnails load straight from the provider's CDN. When Qt's network stack
  refuses a redirect that `curl` is happy with, the cell quietly falls back to
  a locally cached copy instead of leaving a hole in the grid.
- Everything with a side effect — downloading, `wl-copy`, `wtype`, saving —
  lives in `bin/omagif-action`, so it can be exercised from a shell without the
  overlay. Cached files are named by the SHA-1 of their URL, which also means a
  GIF title full of quotes and slashes never shapes a path.
- First-run setup is a terminal script, not a form in the overlay, following
  the same pattern the other third-party Omarchy plugins use: the UI detects
  that it is unconfigured and launches `./setup` through
  `omarchy-launch-floating-terminal-with-presentation`. A terminal can open a
  browser, take a pasted key, check it against the live API, and offer to edit
  `bindings.lua` — none of which belongs in a layer-shell overlay holding
  exclusive keyboard focus.

## Developing

The shell watches `~/.config/omarchy/plugins/` with `inotifywait` and reloads
plugin code on save — but that applies to **`.qml` files only**:

| Changed | Takes effect |
| --- | --- |
| `Omagif.qml` | on save (close and reopen the overlay) |
| **`Widget.qml`** | **only after `omarchy restart shell`** |
| **`Providers.js`, `providers/*.js`** | **only after `omarchy restart shell`** |
| `providers/index.json` | on save, via a watching `FileView` |
| `bin/*`, `setup` | immediately — scripts are re-read per invocation |
| `~/.config/omagif/config.json` | on save, via a watching `FileView` |
| `manifest.json` | `omarchy-shell shell rescanPlugins` |

The bar widget is the surprise: a plugin reload recreates the overlay but
leaves the widget already mounted in the bar, so an edited icon or tooltip
keeps showing the old one while the file on disk plainly says otherwise.

The `.js` case is the one that bites: `import "Providers.js" as Providers`
leaves the compiled JS in the QML engine's cache, and neither a plugin reload
nor `rescanPlugins` evicts it. Edits to that file look like they did nothing —
the overlay reloads, the log says so, and the old behaviour continues. If a
change to provider or URL logic seems to be ignored, restart the shell before
debugging anything else.

### Tests

```bash
node --test test/            # everything
node --test test/registry.test.mjs   # offline only — no network needed
```

Node 18 or newer; there is nothing to install. `test/harness.mjs` loads the
real `Providers.js` and `providers/*.js` by stripping their `.import` header —
the one line the QML engine understands and node does not — so the tests
exercise the shipped files rather than a copy that can drift.

The suite is deliberately an *integration* suite. It talks to Giphy, because
the failures worth catching are the ones Giphy causes:

| File | Needs | Catches |
| --- | --- | --- |
| `registry.test.mjs` | nothing | a provider missing from the catalogue or the module registry, a keyless entry with no caveat, broken URL building |
| `shell.test.mjs` | nothing | `setup` and `bin/omagif` breaking — syntax, the executable bit, and running the CLI **through its symlink**, which is how `omagif install` sets it up |
| `keyless.test.mjs` | network | **Giphy changing its search page** — the parse yields nothing while the request still returns `200` |
| `keyed.test.mjs` | `GIPHY_API_KEY` | the API changing shape, renditions disappearing, offset paging breaking |

The symlink case has already bitten once: the CLI took the dirname of
`${BASH_SOURCE[0]}` without resolving the link, so running it as `omagif` put
`ROOT_DIR` at `~/.local`. `omagif setup` died on a path that did not exist and
`omagif doctor` silently listed no providers at all. `doctor` exits non-zero on
a machine with no omarchy or Wayland tools, so those tests assert on what it
printed rather than on its exit status.

Set `GIPHY_API_KEY` to run the keyed tests locally; without it they skip rather
than fail. One test there needs no key at all — it checks that a *rejected* key
is reported with its status, which is what the picker keys its "check the API
key" advice off.

### The daily run

[`.github/workflows/integration.yml`](.github/workflows/integration.yml) runs
the whole suite every morning, plus on pull requests that touch provider code.
The daily schedule is the point: the keyless provider reads markup Giphy never
promised to keep, so that breakage arrives on Giphy's timetable, not on ours.
A failed scheduled run opens (or comments on) an issue, since nobody is
watching a cron.

It needs one repository secret, **`GIPHY_API_KEY`** — Settings → Secrets and
variables → Actions. The keyless job needs no secret, so it still does its job
on pull requests from forks, where secrets are withheld.

Note that GitHub only runs scheduled workflows from the **default branch**, so
the daily run starts once this is on `main`.

## License

MIT
