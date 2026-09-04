// Tenor provider module. See providers/README.md for the contract.
//
// Disabled in providers/index.json: Google stopped accepting new Tenor API
// clients in January 2026, so a fresh install has no way to obtain a key. The
// v2 endpoint still serves existing keys — it validates them and answers
// normally — so the module is kept intact and anyone who already has a key can
// still select it. If signups reopen, flip `enabled` in index.json and this
// works again with no other change.

var id = "tenor"

function trimmed(value) {
  return String(value === undefined || value === null ? "" : value).trim()
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function query(params) {
  var parts = []
  for (var i = 0; i < params.length; i++) {
    var value = trimmed(params[i][1])
    if (!value) continue
    parts.push(encodeURIComponent(params[i][0]) + "=" + encodeURIComponent(value))
  }
  return parts.join("&")
}

function pickUrl(candidates) {
  for (var i = 0; i < candidates.length; i++) {
    var entry = candidates[i]
    if (!isObject(entry)) continue
    var url = trimmed(entry.url)
    if (url) return url
  }
  return ""
}

function pickDims(candidates) {
  for (var i = 0; i < candidates.length; i++) {
    var entry = candidates[i]
    if (!isObject(entry)) continue
    if (Array.isArray(entry.dims) && entry.dims.length === 2) {
      var dw = parseInt(entry.dims[0], 10)
      var dh = parseInt(entry.dims[1], 10)
      if (dw > 0 && dh > 0) return { width: dw, height: dh }
    }
  }
  return { width: 0, height: 0 }
}

// `cursor` is Tenor's opaque `pos` token rather than a numeric offset.
function searchUrl(key, settings, term, limit, cursor) {
  var settingsObject = isObject(settings) ? settings : {}
  var searchTerm = trimmed(term)
  return "https://tenor.googleapis.com/v2/" + (searchTerm ? "search" : "featured") + "?" + query([
    ["key", key],
    ["client_key", "omagif"],
    ["q", searchTerm],
    ["limit", limit],
    ["pos", cursor],
    ["media_filter", "tinygif,gif,mediumgif"],
    ["contentfilter", trimmed(settingsObject.contentFilter) || "medium"],
    ["locale", trimmed(settingsObject.locale) || "en_US"]
  ])
}

function item(entry) {
  if (!isObject(entry)) return null
  var formats = isObject(entry.media_formats) ? entry.media_formats : {}
  var preview = pickUrl([formats.tinygif, formats.nanogif, formats.gif])
  var full = pickUrl([formats.gif, formats.mediumgif, formats.tinygif])
  if (!preview && !full) return null
  var dims = pickDims([formats.tinygif, formats.gif, formats.mediumgif])
  return {
    id: trimmed(entry.id),
    title: trimmed(entry.content_description) || trimmed(entry.title),
    previewUrl: preview || full,
    gifUrl: full || preview,
    pageUrl: trimmed(entry.itemurl) || trimmed(entry.url),
    width: dims.width,
    height: dims.height
  }
}

function parse(raw, previousCursor) {
  var payload
  try {
    payload = JSON.parse(raw)
  } catch (e) {
    return { items: [], next: "", error: "Unreadable response from Tenor" }
  }

  if (isObject(payload) && isObject(payload.error))
    return { items: [], next: "", status: parseInt(payload.error.code, 10) || 0,
             error: trimmed(payload.error.message) || "Request rejected" }

  var raws = Array.isArray(payload.results) ? payload.results : []
  var items = []
  for (var i = 0; i < raws.length; i++) {
    var parsed = item(raws[i])
    if (parsed) items.push(parsed)
  }

  // Tenor returns an opaque cursor and signals the end with "0" or "".
  var pos = trimmed(payload.next)
  var next = (pos && pos !== "0" && raws.length > 0) ? pos : ""

  return { items: items, next: next, error: "" }
}

// Tenor's media URLs carry no request-scoped query string, so dropping the
// query is enough to make one worth sharing.
function shortDirectUrl(entry) {
  return trimmed(entry.gifUrl).split("?")[0]
}
