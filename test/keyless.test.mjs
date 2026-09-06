// Live checks against giphy.com's public search page.
//
// This is the canary the daily run exists for. The keyless provider reads
// markup Giphy never promised to keep, so the failure it must catch is a
// redesign: the request still returns 200 and the parse quietly yields
// nothing. "Zero items" is therefore a hard failure here, not an empty result.

import { test, describe, before } from "node:test"
import assert from "node:assert/strict"
import { loadModules, fetchText, headStatus, assertItemShape } from "./harness.mjs"

const GiphyKeyless = loadModules()["giphy-keyless"]

// Giphy returns 25 tiles per page today. Asserting a floor well under that
// catches the grid disappearing without failing over normal drift in how many
// results a term happens to have.
const MINIMUM_ITEMS = 8

async function search(term) {
  const url = GiphyKeyless.searchUrl("", {}, term, 40, "")
  const { status, body } = await fetchText(url)
  return { url, status, body, parsed: GiphyKeyless.parse(body, "") }
}

describe("keyless search (live)", () => {
  let result

  before(async () => {
    result = await search("cat")
  })

  test("the search page still answers", () => {
    assert.equal(result.status, 200, `GET ${result.url} returned ${result.status}`)
  })

  test("results are still parsed out of the page", () => {
    assert.equal(result.parsed.error, "", result.parsed.error)
    assert.ok(
      result.parsed.items.length >= MINIMUM_ITEMS,
      `parsed ${result.parsed.items.length} items from ${result.url}, expected at least ` +
        `${MINIMUM_ITEMS}. Giphy has most likely changed the markup this provider reads ` +
        `(it looks for anchors carrying data-giphy-id).`
    )
  })

  test("every item has the full shape the picker needs", () => {
    for (const item of result.parsed.items) {
      assertItemShape(assert, item)
    }
  })

  test("titles are real text, not blanks", () => {
    // Titles come from the tile's alt attribute and name the saved file. If
    // Giphy drops them the picker still works, so this is a warning-shaped
    // fact rather than a shape failure — but most items should have one.
    const titled = result.parsed.items.filter((i) => i.title.trim().length > 0)
    assert.ok(
      titled.length >= result.parsed.items.length / 2,
      `only ${titled.length}/${result.parsed.items.length} items had a title`
    )
  })

  test("HTML entities in titles are decoded", () => {
    for (const item of result.parsed.items) {
      assert.doesNotMatch(item.title, /&#x?[0-9a-f]+;|&(amp|quot|lt|gt|apos);/i,
        `undecoded entity in title: ${JSON.stringify(item.title)}`)
    }
  })

  test("ids are unique across the page", () => {
    const ids = result.parsed.items.map((i) => i.id)
    assert.equal(new Set(ids).size, ids.length, "duplicate ids in one page of results")
  })

  test("the results report themselves as exhausted", () => {
    // The page ignores ?page=, so a non-empty cursor would make the picker
    // scroll for a second page that never arrives.
    assert.equal(result.parsed.next, "")
  })
})

describe("keyless URLs resolve (live)", () => {
  let items

  before(async () => {
    const { parsed } = await search("dancing cat")
    items = parsed.items.slice(0, 3)
    assert.ok(items.length > 0, "no items to check URLs for")
  })

  test("preview renditions are real GIFs", async () => {
    for (const item of items) {
      const { status, type } = await headStatus(item.previewUrl)
      assert.equal(status, 200, `${item.previewUrl} returned ${status}`)
      assert.match(type, /^image\//, `${item.previewUrl} served ${type}`)
    }
  })

  test("full renditions are real GIFs", async () => {
    for (const item of items) {
      const { status, type } = await headStatus(item.gifUrl)
      assert.equal(status, 200, `${item.gifUrl} returned ${status}`)
      assert.match(type, /^image\//, `${item.gifUrl} served ${type}`)
    }
  })

  test("share links resolve, so a pasted link works for the recipient", async () => {
    // The whole reason ids are rebuilt into permalinks instead of reusing the
    // media URLs in the markup: those carry a request-scoped cid and 403.
    for (const item of items) {
      const { status } = await headStatus(item.pageUrl)
      assert.equal(status, 200, `${item.pageUrl} returned ${status}`)
    }
  })
})

describe("keyless trending and multi-word (live)", () => {
  test("an empty term returns the trending grid", async () => {
    const { url, status, parsed } = await search("")
    assert.equal(status, 200, `GET ${url} returned ${status}`)
    assert.equal(parsed.error, "")
    assert.ok(
      parsed.items.length >= MINIMUM_ITEMS,
      `trending parsed ${parsed.items.length} items from ${url}`
    )
  })

  test("a multi-word term is not lost to a redirect", async () => {
    // Built as /search/happy-birthday. If Giphy ever stops serving that form
    // directly, the picker's curl (which has no -L) would get an empty body.
    const { url, status, parsed } = await search("happy birthday")
    assert.equal(status, 200, `GET ${url} returned ${status}`)
    assert.ok(
      parsed.items.length >= MINIMUM_ITEMS,
      `"happy birthday" parsed ${parsed.items.length} items from ${url}`
    )
  })
})
