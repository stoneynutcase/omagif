// Offline checks on the catalogue and the registry that reads it. No network,
// so these still say something useful on a runner with no secret and no route
// to Giphy.

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { loadProviders, loadModules, loadCatalogue } from "./harness.mjs"

const Providers = loadProviders()
const modules = loadModules()
const catalogue = loadCatalogue()

describe("catalogue", () => {
  test("every entry has a module registered under the same id", () => {
    const registered = new Set(Object.values(modules).map((m) => m.id))
    for (const entry of catalogue.providers) {
      assert.ok(
        registered.has(entry.id),
        `providers/index.json lists "${entry.id}" but no module declares that id`
      )
    }
  })

  test("every module appears in the catalogue", () => {
    const listed = new Set(catalogue.providers.map((e) => e.id))
    for (const module of Object.values(modules)) {
      assert.ok(
        listed.has(module.id),
        `module "${module.id}" is registered but missing from providers/index.json`
      )
    }
  })

  test("each entry carries what setup needs to act on it", () => {
    for (const entry of catalogue.providers) {
      assert.equal(typeof entry.label, "string")
      assert.ok(entry.label.length > 0, `${entry.id} needs a label`)
      if (entry.keyless === true) {
        // Setup prints this instead of a key page. Without it a keyless
        // provider looks strictly better than the keyed one, which it is not.
        assert.ok(
          typeof entry.caveat === "string" && entry.caveat.length > 0,
          `${entry.id} is keyless and must state a caveat`
        )
      } else {
        assert.ok(entry.keyUrl, `${entry.id} needs a keyUrl for setup to open`)
      }
      if (entry.enabled !== true) {
        assert.ok(entry.disabledReason, `${entry.id} is disabled and must say why`)
      }
    }
  })

  test("every module implements the provider contract", () => {
    for (const module of Object.values(modules)) {
      for (const fn of ["searchUrl", "parse", "shortDirectUrl"]) {
        assert.equal(typeof module[fn], "function", `${module.id} must export ${fn}()`)
      }
    }
  })
})

describe("readiness", () => {
  test("a keyless provider is ready with no config at all", () => {
    assert.equal(Providers.isKeyless(catalogue, "giphy-keyless"), true)
    assert.equal(Providers.isConfigured({}, catalogue, "giphy-keyless"), true)
  })

  test("a keyed provider is not ready until a key is saved", () => {
    assert.equal(Providers.isKeyless(catalogue, "giphy"), false)
    assert.equal(Providers.isConfigured({}, catalogue, "giphy"), false)
    assert.equal(
      Providers.isConfigured({ giphy: { apiKey: "k" } }, catalogue, "giphy"),
      true
    )
  })

  test("searchUrl refuses a keyed provider with no key, but not a keyless one", () => {
    assert.equal(Providers.searchUrl({}, catalogue, "giphy", "cat", ""), "")
    assert.ok(Providers.searchUrl({}, catalogue, "giphy-keyless", "cat", ""))
  })

  test("Ctrl+P only offers providers that can actually search", () => {
    // Keyless alone is one ready provider, so there is nothing to swap to.
    assert.equal(
      Providers.nextProvider({ provider: "giphy-keyless" }, catalogue, "giphy-keyless"),
      ""
    )
    // With a Giphy key there are two, and they alternate.
    const config = { provider: "giphy", giphy: { apiKey: "k" } }
    assert.equal(Providers.nextProvider(config, catalogue, "giphy"), "giphy-keyless")
    assert.equal(Providers.nextProvider(config, catalogue, "giphy-keyless"), "giphy")
  })
})

describe("keyless URL building", () => {
  const url = (term) => modules.GiphyKeyless.searchUrl("", {}, term, 40, "")

  test("multi-word terms use the hyphen form", () => {
    // The picker searches with `curl` and no -L. The percent-encoded form
    // 308-redirects, which would arrive as an empty body.
    assert.equal(url("happy birthday"), "https://giphy.com/search/happy-birthday")
    assert.equal(url("  Multi   Word!  "), "https://giphy.com/search/multi-word")
  })

  test("non-ASCII terms survive as percent-encoding", () => {
    assert.equal(url("feliz cumpleaños"), "https://giphy.com/search/feliz-cumplea%C3%B1os")
    assert.equal(url("猫"), "https://giphy.com/search/%E7%8C%AB")
  })

  test("an empty or punctuation-only term falls back to trending", () => {
    for (const term of ["", "   ", "!!!"]) {
      assert.equal(url(term), "https://giphy.com/explore/trending")
    }
  })

  test("a cursor yields no URL, because there is no second page", () => {
    assert.equal(modules.GiphyKeyless.searchUrl("", {}, "cat", 40, "25"), "")
  })
})

describe("keyless parse failure modes", () => {
  test("a page with no results explains itself rather than looking empty", () => {
    const parsed = modules.GiphyKeyless.parse(
      "<html><body>giphy.com and nothing else</body></html>",
      ""
    )
    assert.equal(parsed.items.length, 0)
    assert.match(parsed.error, /layout/i)
  })

  test("a response that is not a Giphy page is reported differently", () => {
    const parsed = modules.GiphyKeyless.parse("<html>nope</html>", "")
    assert.equal(parsed.items.length, 0)
    assert.match(parsed.error, /unreadable|rate limiting/i)
  })

  test("empty and null bodies do not throw", () => {
    for (const raw of ["", null, undefined]) {
      const parsed = modules.GiphyKeyless.parse(raw, "")
      assert.equal(parsed.items.length, 0)
      assert.ok(parsed.error)
    }
  })
})
