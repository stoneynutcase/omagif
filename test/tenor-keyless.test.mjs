// Live checks against tenor.com's public search page.
//
// The same canary as keyless.test.mjs, for the other scraped provider: the
// request keeps returning 200 while the parse quietly yields nothing, so zero
// items is a hard failure here.
//
// Tenor makes that signal cleaner than Giphy does. It answers even a nonsense
// query with fallback results, so there is no "this term genuinely has no
// matches" case to confuse with breakage.

import { test, describe, before } from "node:test"
import assert from "node:assert/strict"
import { loadModules, fetchText, headStatus, assertItemShape } from "./harness.mjs"

const TenorKeyless = loadModules()["tenor-keyless"]

// Tenor serves 49 tiles per search and 50 on the front page. A floor well
// under that catches the grid disappearing without failing over normal drift.
const MINIMUM_ITEMS = 15

async function search(term) {
  const url = TenorKeyless.searchUrl("", {}, term, 40, "")
  const { status, body } = await fetchText(url)
  return { url, status, body, parsed: TenorKeyless.parse(body, "") }
}

describe("keyless Tenor search (live)", () => {
  let result

  before(async () => {
    result = await search("cat")
  })

  test("the search page still answers", () => {
    assert.equal(result.status, 200, `GET ${result.url} returned ${result.status}`)
  })

  test("the -gifs suffix is still what the search path wants", () => {
    // /search/cat 301-redirects to /search/cat-gifs, and the picker's curl has
    // no -L, so losing the suffix would mean an empty body every time.
    assert.equal(result.url, "https://tenor.com/search/cat-gifs")
  })

  test("results are still parsed out of the page", () => {
    assert.equal(result.parsed.error, "", result.parsed.error)
    assert.ok(
      result.parsed.items.length >= MINIMUM_ITEMS,
      `parsed ${result.parsed.items.length} items from ${result.url}, expected at least ` +
        `${MINIMUM_ITEMS}. Tenor has most likely changed the markup this provider reads ` +
        `(it looks for <figure class="UniversalGifListItem"> wrapping a /view/ link).`
    )
  })

  test("every item has the full shape the picker needs", () => {
    for (const item of result.parsed.items) {
      assertItemShape(assert, item)
    }
  })

  test("ids are the numeric post id from the share path", () => {
    for (const item of result.parsed.items) {
      assert.match(item.id, /^\d+$/, `id ${JSON.stringify(item.id)} is not a Tenor post id`)
    }
  })

  test("titles are real text, not blanks", () => {
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

  test("media URLs carry no query string", () => {
    // Unlike Giphy's, Tenor's are already clean — nothing request-scoped to
    // strip, which is why a copied link works for whoever you send it to.
    for (const item of result.parsed.items) {
      assert.ok(!item.previewUrl.includes("?"), `preview URL has a query: ${item.previewUrl}`)
      assert.ok(!item.gifUrl.includes("?"), `full URL has a query: ${item.gifUrl}`)
    }
  })

  test("the promo tile is not mistaken for a result", () => {
    // Tenor drops an "upload your own GIFs" card into the grid with the same
    // class as a real tile and no /view/ link.
    for (const item of result.parsed.items) {
      assert.ok(!item.pageUrl.includes("/gif-maker"), `promo card parsed as a GIF: ${item.pageUrl}`)
    }
  })

  test("the results report themselves as exhausted", () => {
    // ?page=2 returns the same results, so a cursor would make the picker
    // scroll for a second page that never arrives.
    assert.equal(result.parsed.next, "")
  })
})

describe("keyless Tenor URLs resolve (live)", () => {
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
    // Rebuilt by swapping the rendition suffix on the media id, so this also
    // checks that AAAAC is still the full-size code.
    for (const item of items) {
      const { status, type } = await headStatus(item.gifUrl)
      assert.equal(status, 200, `${item.gifUrl} returned ${status}`)
      assert.match(type, /^image\//, `${item.gifUrl} served ${type}`)
    }
  })

  test("share links resolve", async () => {
    for (const item of items) {
      const { status } = await headStatus(item.pageUrl)
      assert.equal(status, 200, `${item.pageUrl} returned ${status}`)
    }
  })
})

describe("keyless Tenor trending and terms (live)", () => {
  test("an empty term returns the front page grid", async () => {
    const { url, status, parsed } = await search("")
    assert.equal(url, "https://tenor.com/")
    assert.equal(status, 200, `GET ${url} returned ${status}`)
    assert.equal(parsed.error, "")
    assert.ok(
      parsed.items.length >= MINIMUM_ITEMS,
      `the front page parsed ${parsed.items.length} items`
    )
  })

  test("a multi-word term is not lost to a redirect", async () => {
    const { url, status, parsed } = await search("happy birthday")
    assert.equal(url, "https://tenor.com/search/happy-birthday-gifs")
    assert.equal(status, 200, `GET ${url} returned ${status}`)
    assert.ok(parsed.items.length >= MINIMUM_ITEMS, `parsed ${parsed.items.length} items`)
  })

  test("a term that already ends in \"gifs\" is not doubled", async () => {
    const { url, status, parsed } = await search("cat gifs")
    assert.equal(url, "https://tenor.com/search/cat-gifs")
    assert.equal(status, 200)
    assert.ok(parsed.items.length >= MINIMUM_ITEMS)
  })
})
