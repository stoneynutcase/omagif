# Developing Omagif

Notes for working on the plugin. If you just want to use it, the
[README](README.md) is the whole story.

## How it works

- `Omagif.qml` is the overlay: a layer-shell window on the overlay layer with
  exclusive keyboard focus, holding a `GridView` of `AnimatedImage`s.
- `Providers.js` turns `(config, catalogue, query, cursor)` into one URL, and
  the response into a flat `{ id, title, previewUrl, gifUrl, pageUrl }` shape.
  The overlay never sees a service's own field names.
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
  the pattern other third-party Omarchy plugins use: the UI detects that it is
  unconfigured and launches `./setup` through
  `omarchy-launch-floating-terminal-with-presentation`. A terminal can open a
  browser, take a pasted key, check it against the live API, and offer to edit
  `bindings.lua` — none of which belongs in a layer-shell overlay holding
  exclusive keyboard focus.

Omagif never installs, upgrades or removes software. When `setup` finds a
dependency missing it names the package and stops.

## Providers

Each provider is a self-contained module in `providers/<Name>.js` plus an entry
in `providers/index.json` — the single catalogue that the picker, `setup` and
`omagif doctor` all read, so a provider's key URL and sign-up status are stated
exactly once. Adding one is a module, one `.import`, and a JSON entry. The
contract is in [`providers/README.md`](providers/README.md).

**`tenor` (keyed) is present but disabled.** Google stopped accepting new
Tenor API clients in January 2026, so a fresh install has no way to obtain a
key. Its `v2` endpoint still serves *existing* keys, so the module is kept
intact and anyone who already holds one can select it. If signups reopen,
flipping `enabled` in `providers/index.json` brings it back with no other
change. `tenor-keyless` is what a new install gets instead.

### The keyless providers

`providers/GiphyKeyless.js` reads giphy.com's public search page rather than
the API, because the API authenticates every request and the old public beta
key (`dc6zaTOxFJmzC`) now answers `403 BANNED`.

giphy.com renders its result grid server-side, one anchor per GIF carrying
`data-giphy-id`, an absolute `href` (the share link), an inline `aspect-ratio`
and an `alt` title. Only the ids are reused: the media URLs in that markup
embed a `cid` scoped to the request that produced them and `403` for anyone you
send them to, so `i.giphy.com/<id>.gif` and `giphy.com/gifs/<id>` are rebuilt
from the id and stay shareable.

Constraints worth knowing before changing it:

- **No pagination.** `?page=2` returns byte-identical results, so `parse()`
  always reports the results exhausted with `next: ""`.
- **Multi-word terms must use the hyphen form.** `%20` 308-redirects, and the
  picker's `curl` has no `-L`, so a redirect arrives as an empty body.
- **Non-ASCII terms work percent-encoded.** Slugging with `[a-z0-9-]` silently
  destroys them.
- The `ld+json` block on the page carries only five entries, not the full
  grid — it is not a useful parse target.

#### Tenor

`providers/TenorKeyless.js` reads tenor.com the same way, and the site is
friendlier to it: `robots.txt` is `Disallow:` with nothing listed, there is no
restrictive robots meta, and the media URLs carry **no query string**, so
nothing has to be rebuilt to make a link shareable.

Each result is a `<figure class="UniversalGifListItem" data-width data-height>`
wrapping an `/view/<slug>-gif-<id>` link and an `<img>`. The id is the trailing
number on that path — not the media id in the CDN URL, which differs per
rendition.

- **`-gifs` is part of the search path.** `/search/cat` 301-redirects to
  `/search/cat-gifs`, and the picker's `curl` has no `-L`.
- **Empty term means the front page**, `https://tenor.com/`. There is no
  trending path — `/trending` and `/explore/trending` both 404, and
  `/search/trending-gifs` is a literal search for the word.
- **Renditions are a suffix on the media id**: `AAAAS` 82px, `AAAAM` 165px
  (what the grid serves), `AAAAd` 338px, `AAAAC` full. The grid serves GIF or
  WebP depending on negotiation (`AAAAM` vs `AAAAm`), so the parser captures
  the base id and slug and rebuilds the URL rather than reusing it.
- **No pagination.** `?page=2` returns the same results.
- **Tenor answers a nonsense query with fallback results**, so zero items means
  the markup moved — there is no "genuinely no matches" case to confuse it with.
- **The grid contains a promo tile** with the same class and no `/view/` link.
- Tenor's GIFs are much heavier than Giphy's: a grid of previews averages
  ~17 MB against ~0.2 MB, and a full rendition can exceed 20 MB.

## Reloading

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
nor `rescanPlugins` evicts it. Edits look like they did nothing — the overlay
reloads, the log says so, and the old behaviour continues. If a change to
provider or URL logic seems to be ignored, restart the shell before debugging
anything else.

## Testing a local branch

The plugin is installed as its own clone at
`~/.config/omarchy/plugins/stoneynutcase.omagif`, separate from wherever you
edit it, so editing your checkout changes nothing about the running plugin.
`omarchy plugin add` takes any git URL, including a local path:

```bash
omarchy plugin remove stoneynutcase.omagif --yes
rm -rf ~/.config/omagif ~/.cache/omagif ~/.local/state/omagif   # optional: force first-run
omarchy plugin add /path/to/your/checkout --enable --yes
omarchy restart shell
```

It clones whatever branch your checkout's `HEAD` points at, so commit first —
uncommitted work does not come along.

## Tests

```bash
node --test test/                      # everything
node --test test/registry.test.mjs     # offline only, no network
```

Node 18 or newer; nothing to install. `test/harness.mjs` loads the real
`Providers.js` and `providers/*.js` by stripping their `.import` header — the
one line the QML engine understands and node does not — so the tests exercise
the shipped files rather than a copy that can drift.

It is deliberately an *integration* suite, because the failures worth catching
are the ones Giphy causes:

| File | Needs | Catches |
| --- | --- | --- |
| `registry.test.mjs` | nothing | a provider missing from the catalogue or the module registry, a keyless entry with no caveat, broken URL building |
| `shell.test.mjs` | nothing | `setup` and `bin/omagif` breaking — syntax, the executable bit, and running the CLI **through its symlink**, which is how `omagif install` sets it up |
| `keyless.test.mjs` | network | **Giphy changing its search page** — the parse yields nothing while the request still returns `200` |
| `tenor-keyless.test.mjs` | network | the same, for tenor.com |
| `keyed.test.mjs` | `GIPHY_API_KEY` | the API changing shape, renditions disappearing, offset paging breaking |

Set `GIPHY_API_KEY` to run the keyed tests locally; without it they skip rather
than fail. One test there needs no key at all — it checks that a *rejected* key
is reported with its status, which is what the picker keys its "check the API
key" advice off.

The symlink case has already bitten once: the CLI took the dirname of
`${BASH_SOURCE[0]}` without resolving the link, so running it as `omagif` put
`ROOT_DIR` at `~/.local`. `omagif setup` died on a path that did not exist and
`omagif doctor` silently listed no providers at all. `doctor` exits non-zero on
a machine with no omarchy or Wayland tools, so those tests assert on what it
printed rather than on its exit status.

## The daily run

[`.github/workflows/integration.yml`](.github/workflows/integration.yml) runs
the suite every morning, plus on pull requests that touch provider or script
code. The daily schedule is the point: the keyless provider reads markup Giphy
never promised to keep, so that breakage arrives on Giphy's timetable, not on
ours. A failed scheduled run opens (or comments on) an issue, since nobody is
watching a cron.

It needs one repository secret, **`GIPHY_API_KEY`** — Settings → Secrets and
variables → Actions. The keyless job needs no secret, so it still does its job
on pull requests from forks, where secrets are withheld.

GitHub only runs scheduled workflows from the **default branch**, so the daily
run happens on `main`.
