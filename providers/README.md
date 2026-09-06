# Adding a GIF provider

A provider is one JavaScript module plus one catalogue entry. Nothing outside
this directory needs to learn the service's field names — `Omagif.qml` only ever
sees the flat item shape the module produces.

## 1. Write `providers/<Name>.js`

Copy `Giphy.js` and rewrite three functions. The modules are deliberately
self-contained — their small helpers are duplicated rather than shared — so
copying one file gives you a working starting point.

```js
var id = "example"                                  // matches index.json

// Build one curl-able URL. An empty `term` means "what's popular now".
// `cursor` is whatever your own parse() returned as `next`, so it can be an
// offset, an opaque token, or anything else you like.
function searchUrl(key, settings, term, limit, cursor) → String

// Turn the response body into { items, next, error }.
// `next` is "" when the results are exhausted. `error` is a human-readable
// string; the picker shows it in place of the grid.
function parse(raw, previousCursor) → Object

// A short, stable link to the GIF itself, for `linkStyle: "direct"`.
function shortDirectUrl(item) → String
```

Every item in `items` must be:

```js
{
  id,          // stable id; also names the direct permalink where one exists
  title,       // human text, used for the saved/attached filename
  previewUrl,  // small animated rendition for the grid
  gifUrl,      // full rendition, downloaded for copy/save
  pageUrl,     // canonical share link, what a copied link points at
  width, height
}
```

`previewUrl` and `gifUrl` may be the same URL. `pageUrl` may be empty, in which
case links fall back to `gifUrl`.

## 2. Register it in `Providers.js`

One `.import` at the top, one line in `modules()`:

```js
.import "providers/Example.js" as ExampleModule
...
MODULES[ExampleModule.id] = ExampleModule
```

## 3. Add it to `index.json`

```json
{
  "id": "example",
  "label": "Example",
  "enabled": true,
  "keyUrl": "https://example.com/developers",
  "keyHint": "Where to click to get a key.",
  "verifyUrl": "https://api.example.com/search?key={key}&limit=1"
}
```

`verifyUrl` is called by `./setup` with `{key}` substituted, to check a pasted
key actually works before saving it. `keyUrl` and `keyHint` are what setup
shows the user. Settings the user can tune go under a config key named after
the provider id, and reach your module as `settings`:

```json
{ "example": { "apiKey": "…", "rating": "pg-13" } }
```

## Providers that need no key

Add `"keyless": true` and setup stops asking for one: no key page, no paste, no
verify step, and nothing seeded into the config section. The picker treats the
provider as ready the moment it is selected, and `searchUrl()` is handed `""`
as its key, which it should ignore.

```json
{
  "id": "example-keyless",
  "label": "Example (no API key)",
  "enabled": true,
  "keyless": true,
  "caveat": "What this costs, in one sentence — setup prints it and asks."
}
```

`caveat` is the honest-trade-off line. Keyless providers tend to reach a
service by a route it did not design for you, so say what breaks: fewer
results, no filters, or a page layout that can change under you.
`GiphyKeyless.js` is the worked example — it scrapes giphy.com's server-side
grid, returns one page, and always reports the results exhausted by handing
back `next: ""`.

## Disabling one

Set `"enabled": false` and add a `disabledReason`. It disappears from setup and
from the provider switch — except for users who already hold a key, who keep
working. That's how `Tenor` currently sits: Google stopped issuing new Tenor
API keys in January 2026, but the v2 endpoint still serves existing ones, so
the module stays intact and one flag brings it back.

## Testing

`Providers.js` and everything in here is JavaScript imported into QML, which
the engine caches — **`omarchy restart shell` after every edit**, or you will
be looking at the previous version. The modules are plain enough to exercise
outside the shell too:

```bash
node -e 'const fs=require("fs"),m={};
new Function("exports", fs.readFileSync("providers/Giphy.js","utf8")+"\nexports.parse=parse")(m);
console.log(m.parse("{\"data\":[]}", "0"))'
```
