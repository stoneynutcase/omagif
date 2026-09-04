.import "providers/Giphy.js" as GiphyModule
.import "providers/Tenor.js" as TenorModule

// Provider registry and shared config accessors.
//
// Everything a single GIF service knows lives in providers/<Id>.js; everything
// a human needs to know about it lives in providers/index.json, which both this
// file's callers and ./setup read. Omagif.qml never sees a service's field
// names, only the flat item shape the modules produce.
//
// Adding a provider: write providers/<Id>.js, add one `.import` above and one
// line in modules(), and add an entry to providers/index.json. Nothing else in
// the plugin needs to change. See providers/README.md.

var MODULES = null

function modules() {
  if (!MODULES) {
    MODULES = {}
    MODULES[GiphyModule.id] = GiphyModule
    MODULES[TenorModule.id] = TenorModule
  }
  return MODULES
}

function trimmed(value) {
  return String(value === undefined || value === null ? "" : value).trim()
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

// ------------------------------------------------------------------ catalogue

// `catalogue` is the parsed providers/index.json, handed in by the caller that
// loaded it. Everything here degrades to an empty list rather than throwing
// when it hasn't arrived yet.
function entries(catalogue) {
  if (!isObject(catalogue) || !Array.isArray(catalogue.providers)) return []
  var out = []
  for (var i = 0; i < catalogue.providers.length; i++) {
    var entry = catalogue.providers[i]
    if (!isObject(entry)) continue
    var id = trimmed(entry.id)
    if (id && modules()[id]) out.push(entry)
  }
  return out
}

function entryFor(catalogue, id) {
  var list = entries(catalogue)
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === trimmed(id)) return list[i]
  }
  return null
}

function providerLabel(catalogue, id) {
  var entry = entryFor(catalogue, id)
  return entry ? trimmed(entry.label) || trimmed(entry.id) : trimmed(id)
}

// A provider is offerable when the catalogue still lists it as enabled, or
// when this user already holds a key for it — a service that stops issuing new
// keys shouldn't break the setup of someone who got one while they could.
function isUsable(config, catalogue, id) {
  var entry = entryFor(catalogue, id)
  if (!entry) return false
  return entry.enabled === true || apiKey(config, id).length > 0
}

function usableProviders(config, catalogue) {
  var list = entries(catalogue)
  var out = []
  for (var i = 0; i < list.length; i++) {
    if (isUsable(config, catalogue, list[i].id)) out.push(list[i].id)
  }
  return out
}

// The provider to actually search with: whatever the config names, as long as
// it is usable, else the first one that is.
function providerName(config, catalogue) {
  var configured = trimmed(isObject(config) ? config.provider : "").toLowerCase()
  if (configured && isUsable(config, catalogue, configured)) return configured
  var usable = usableProviders(config, catalogue)
  return usable.length > 0 ? usable[0] : configured
}

// Next provider the Ctrl+P switch should land on: only ones with a key, since
// switching to a keyless provider would just empty the grid.
function nextProvider(config, catalogue, current) {
  var ready = []
  var usable = usableProviders(config, catalogue)
  for (var i = 0; i < usable.length; i++) {
    if (apiKey(config, usable[i]).length > 0) ready.push(usable[i])
  }
  if (ready.length < 2) return ""
  var at = ready.indexOf(trimmed(current))
  return ready[(at + 1) % ready.length]
}

// --------------------------------------------------------------------- config

function section(config, id) {
  var value = isObject(config) ? config[trimmed(id)] : null
  return isObject(value) ? value : {}
}

function apiKey(config, id) {
  return trimmed(section(config, id).apiKey)
}

function limit(config) {
  var n = parseInt(isObject(config) ? config.limit : NaN, 10)
  if (isNaN(n) || n <= 0) return 40
  return Math.min(50, n)
}

function columns(config) {
  var n = parseInt(isObject(config) ? config.columns : NaN, 10)
  if (isNaN(n) || n <= 0) return 4
  return Math.min(8, Math.max(2, n))
}

function cacheDir(config, home) {
  var dir = trimmed(isObject(config) ? config.cacheDir : "")
  if (!dir) return home + "/.cache/omagif"
  if (dir.charAt(0) === "~") return home + dir.slice(1)
  return dir
}

function saveDir(config, home) {
  var dir = trimmed(isObject(config) ? config.saveDir : "")
  if (!dir) return home + "/Pictures/gifs"
  if (dir.charAt(0) === "~") return home + dir.slice(1)
  return dir
}

// What Enter does. `wl-copy -t` overrides the MIME type rather than adding
// one, so the clipboard carries exactly one payload and the choice matters.
//
// The default is `file` — a `text/uri-list` pointing at the downloaded GIF —
// because it is the one that actually arrives as a playing GIF: the receiving
// app attaches the real file, animation and all. Tested against Signal.
//
// The alternatives are kept on modifiers because each fails somewhere:
// `image/gif` bytes are rarely requested at all (apps ask the clipboard for
// `image/png`, which is why Omarchy's own clipboard manager watches only
// `text` and `image/png`), and a link depends on the far end fetching and
// unfurling it, which some preview fetchers refuse.
var ENTER_ACTIONS = {
  image: "copy-image",
  file: "copy-file",
  link: "copy-url",
  paste: "paste-url"
}

function enterAction(config) {
  var name = trimmed(isObject(config) ? config.enterAction : "").toLowerCase()
  return ENTER_ACTIONS[name] || ENTER_ACTIONS.file
}

function enterActionLabel(config) {
  var verb = enterAction(config)
  if (verb === "copy-file") return "copy file"
  if (verb === "copy-url") return "copy link"
  if (verb === "paste-url") return "paste link"
  return "copy GIF"
}

// Which URL a shared link should point at. `direct` is the media file itself:
// it downloads fine — that is what the cache fetches with curl — but the query
// string on it is scoped to the API request that produced it and the CDNs
// apply hotlink protection, so pasted into a chat it tends to 403 for whoever
// clicks it. `page` is the canonical share link, which is what the services
// intend for sharing and what chat apps unfurl into a playing GIF.
function linkStyle(config) {
  var value = trimmed(isObject(config) ? config.linkStyle : "").toLowerCase()
  return value === "direct" ? "direct" : "page"
}

// The URL a given action should act on: sharing wants a link that survives
// being handed to someone else, downloading wants the bytes. The search URL is
// kept for downloads because curl fetches it happily and it is already the
// rendition the module picked.
function urlFor(item, verb, config, id) {
  if (!isObject(item)) return ""
  var page = trimmed(item.pageUrl)
  var direct = trimmed(item.gifUrl)
  if (verb === "copy-url" || verb === "paste-url") {
    if (linkStyle(config) === "direct") {
      var module = modules()[trimmed(id)]
      return (module ? trimmed(module.shortDirectUrl(item)) : "") || page || direct
    }
    return page || direct
  }
  if (verb === "open") return page || direct
  return direct || page
}

// ------------------------------------------------------------------ dispatch

function searchUrl(config, id, searchTerm, cursor) {
  var module = modules()[trimmed(id)]
  if (!module) return ""
  var key = apiKey(config, id)
  if (!key) return ""
  return module.searchUrl(key, section(config, id), searchTerm, limit(config), cursor)
}

function parse(id, raw, previousCursor) {
  var module = modules()[trimmed(id)]
  if (!module) return { items: [], next: "", error: "Unknown provider: " + id }
  return module.parse(raw, previousCursor)
}
