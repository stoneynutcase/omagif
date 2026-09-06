// Live checks against Giphy's REST API, using the key in GIPHY_API_KEY.
//
// Skipped wholesale when that secret is absent, so the suite still runs on a
// fork's pull request — where secrets are deliberately withheld — instead of
// failing for a reason the contributor cannot fix.

import { test, describe, before } from "node:test"
import assert from "node:assert/strict"
import { loadModules, fetchText, headStatus, assertItemShape } from "./harness.mjs"

const Giphy = loadModules()["giphy"]

const API_KEY = (process.env.GIPHY_API_KEY || "").trim()
const skip = API_KEY ? false : "GIPHY_API_KEY is not set"

const MINIMUM_ITEMS = 8
const settings = { rating: "pg-13", lang: "en" }

async function search(term, cursor = "") {
  const url = Giphy.searchUrl(API_KEY, settings, term, 25, cursor)
  const { status, body } = await fetchText(url)
  return { url, status, body, parsed: Giphy.parse(body, cursor) }
}

// The key must never reach the log: a failing assertion prints the URL it was
// given, and the key is a query parameter on it.
function redact(url) {
  return url.replace(/api_key=[^&]*/, "api_key=REDACTED")
}

describe("keyed search (live)", { skip }, () => {
  let result

  before(async () => {
    result = await search("cat")
  })

  test("the API accepts the key", () => {
    assert.equal(
      result.status,
      200,
      `GET ${redact(result.url)} returned ${result.status} — the key in GIPHY_API_KEY ` +
        `may be revoked, over quota, or not enabled for the API`
    )
    assert.equal(result.parsed.error, "", result.parsed.error)
  })

  test("results are parsed out of the response", () => {
    assert.ok(
      result.parsed.items.length >= MINIMUM_ITEMS,
      `parsed ${result.parsed.items.length} items, expected at least ${MINIMUM_ITEMS}`
    )
  })

  test("every item has the full shape the picker needs", () => {
    for (const item of result.parsed.items) {
      assertItemShape(assert, item)
    }
  })

  test("ids are unique within a page", () => {
    const ids = result.parsed.items.map((i) => i.id)
    assert.equal(new Set(ids).size, ids.length)
  })

  test("the renditions the parser picks still exist", () => {
    // Giphy's rendition names come and go; Giphy.js walks a preference list
    // for each. If every name in a list disappeared, these would be empty.
    for (const item of result.parsed.items) {
      assert.match(item.previewUrl, /^https:\/\//)
      assert.match(item.gifUrl, /^https:\/\//)
    }
  })
})

describe("keyed pagination (live)", { skip }, () => {
  test("a second page follows the first and does not repeat it", async () => {
    // This is what a key buys over the keyless provider, so it is worth
    // asserting rather than assuming.
    const first = await search("cat")
    assert.ok(first.parsed.next, "first page returned no cursor")

    const second = await search("cat", first.parsed.next)
    assert.equal(second.status, 200)
    assert.equal(second.parsed.error, "")
    assert.ok(
      second.parsed.items.length > 0,
      `cursor ${first.parsed.next} returned an empty second page`
    )

    const firstIds = new Set(first.parsed.items.map((i) => i.id))
    const overlap = second.parsed.items.filter((i) => firstIds.has(i.id))
    assert.ok(
      overlap.length < second.parsed.items.length,
      "the second page repeated the first page exactly — offset paging is broken"
    )
  })
})

describe("keyed trending (live)", { skip }, () => {
  test("an empty term uses the trending endpoint and returns results", async () => {
    const { url, status, parsed } = await search("")
    assert.match(url, /\/v1\/gifs\/trending\?/)
    assert.equal(status, 200)
    assert.equal(parsed.error, "")
    assert.ok(parsed.items.length >= MINIMUM_ITEMS)
  })
})

describe("keyed URLs resolve (live)", { skip }, () => {
  test("the share link and the direct rendition both work", async () => {
    const { parsed } = await search("dancing cat")
    for (const item of parsed.items.slice(0, 2)) {
      const page = await headStatus(item.pageUrl)
      assert.equal(page.status, 200, `${item.pageUrl} returned ${page.status}`)

      const short = Giphy.shortDirectUrl(item)
      const direct = await headStatus(short)
      assert.equal(direct.status, 200, `${short} returned ${direct.status}`)
      assert.match(direct.type, /^image\//, `${short} served ${direct.type}`)
    }
  })
})

// Runs with or without a key: it is about how a refusal is reported, and a
// deliberately invalid key produces one on demand.
describe("keyed error reporting (live)", () => {
  test("a rejected key is reported with its status, not as an empty grid", async () => {
    const url = Giphy.searchUrl("definitely-not-a-real-key", settings, "cat", 5, "")
    const { status, body } = await fetchText(url)
    assert.ok(status >= 400, `expected a refusal, got ${status}`)

    const parsed = Giphy.parse(body, "")
    assert.equal(parsed.items.length, 0)
    assert.ok(parsed.error, "a refusal must carry a message for the picker to show")
    // Omagif.qml keys its "check the API key" advice off this status.
    assert.ok(
      [401, 403].includes(parsed.status),
      `expected status 401/403 on the parsed result, got ${parsed.status}`
    )
  })
})
