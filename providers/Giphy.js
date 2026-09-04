// Giphy provider module. See providers/README.md for the contract.
//
// Deliberately self-contained: its few helpers are duplicated rather than
// shared, so a new provider can be written by copying this one file.

var id = "giphy"

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

// Giphy hands back a bag of renditions under names that come and go, so every
// lookup walks a preference list and takes the first usable URL.
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
    var w = parseInt(entry.width, 10)
    var h = parseInt(entry.height, 10)
    if (w > 0 && h > 0) return { width: w, height: h }
  }
  return { width: 0, height: 0 }
}

// An empty term means "what's popular right now", which Giphy exposes as a
// separate endpoint rather than as an empty query. `cursor` is a result offset.
function searchUrl(key, settings, term, limit, cursor) {
  var settingsObject = isObject(settings) ? settings : {}
  var searchTerm = trimmed(term)
  return "https://api.giphy.com/v1/gifs/" + (searchTerm ? "search" : "trending") + "?" + query([
    ["api_key", key],
    ["q", searchTerm],
    ["limit", limit],
    ["offset", cursor],
    ["rating", trimmed(settingsObject.rating) || "pg-13"],
    ["lang", trimmed(settingsObject.lang) || "en"]
  ])
}

function item(entry) {
  if (!isObject(entry)) return null
  var images = isObject(entry.images) ? entry.images : {}
  var preview = pickUrl([
    images.fixed_width_downsampled,
    images.fixed_width_small,
    images.preview_gif,
    images.fixed_width,
    images.downsized
  ])
  var full = pickUrl([images.downsized_medium, images.downsized, images.original, images.fixed_width])
  if (!preview && !full) return null
  var dims = pickDims([images.fixed_width_downsampled, images.fixed_width_small, images.original])
  return {
    id: trimmed(entry.id),
    title: trimmed(entry.title),
    previewUrl: preview || full,
    gifUrl: full || preview,
    pageUrl: trimmed(entry.url),
    width: dims.width,
    height: dims.height
  }
}

function parse(raw, previousCursor) {
  var payload
  try {
    payload = JSON.parse(raw)
  } catch (e) {
    return { items: [], next: "", error: "Unreadable response from Giphy" }
  }

  if (isObject(payload) && isObject(payload.meta) && parseInt(payload.meta.status, 10) >= 400)
    return { items: [], next: "", error: trimmed(payload.meta.msg) || "Request rejected" }
  if (isObject(payload) && typeof payload.message === "string" && payload.message && !payload.data)
    return { items: [], next: "", error: trimmed(payload.message) }

  var raws = Array.isArray(payload.data) ? payload.data : []
  var items = []
  for (var i = 0; i < raws.length; i++) {
    var parsed = item(raws[i])
    if (parsed) items.push(parsed)
  }

  // Giphy pages by offset: the previous cursor plus this page's size is the
  // next one, and a short page means the results are exhausted.
  var offset = parseInt(previousCursor, 10)
  if (isNaN(offset)) offset = 0
  var pagination = isObject(payload.pagination) ? payload.pagination : {}
  var total = parseInt(pagination.total_count, 10)
  var consumed = offset + raws.length
  var next = ""
  if (raws.length > 0 && (isNaN(total) || consumed < total)) next = String(consumed)

  return { items: items, next: next, error: "" }
}

// The URL a search returns is ~250 characters, with a `v1.<base64>` segment
// carrying the cid of the request that produced it. Giphy publishes a short
// permalink to the same bytes, which is stable and readable.
function shortDirectUrl(entry) {
  var gifId = trimmed(entry.id)
  if (gifId) return "https://i.giphy.com/" + gifId + ".gif"
  return trimmed(entry.gifUrl).split("?")[0]
}
