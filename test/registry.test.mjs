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
      // Without this list a provider can display and download nothing at all,
      // which is the safe way round but looks exactly like a broken service.
      assert.ok(
        Array.isArray(entry.mediaHosts) && entry.mediaHosts.length > 0,
        `${entry.id} needs mediaHosts — every media URL is checked against it`
      )
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

  test("Ctrl+P cycles the keyless providers with no config at all", () => {
    // Both keyless providers are ready the moment they exist, so a fresh
    // install can swap services without ever holding a key.
    const keyless = Providers.usableProviders({}, catalogue)
      .filter((id) => Providers.isKeyless(catalogue, id))
    assert.ok(keyless.length >= 2, `expected at least two keyless providers, got ${keyless}`)

    // Every hop lands on a different ready provider, and the cycle closes.
    const seen = new Set()
    let at = keyless[0]
    for (let hop = 0; hop < keyless.length; hop++) {
      seen.add(at)
      const next = Providers.nextProvider({}, catalogue, at)
      assert.notEqual(next, "", `no swap target from ${at}`)
      assert.notEqual(next, at, `${at} swapped to itself`)
      at = next
    }
    assert.equal(at, keyless[0], "the swap cycle did not return to where it started")
    assert.equal(seen.size, keyless.length, "the cycle skipped a ready provider")
  })

  test("Ctrl+P skips providers with no key and no keyless route", () => {
    // `tenor` is disabled and keyed, so it must never be a swap target.
    const config = { provider: "giphy", giphy: { apiKey: "k" } }
    const targets = new Set()
    let at = "giphy"
    for (let hop = 0; hop < 6; hop++) {
      at = Providers.nextProvider(config, catalogue, at)
      if (!at) break
      targets.add(at)
    }
    assert.ok(!targets.has("tenor"), "swapped to tenor, which has no key")
    assert.ok(targets.has("giphy-keyless"))
  })
})

// A media URL is read out of whatever answered the search, so it is only as
// trustworthy as that response. Omagif.qml drops any item that fails this
// before the grid, the downloader or xdg-open ever sees it.
describe("media URLs are held to the catalogue's hosts", () => {
  const allowed = (id, url) => Providers.isAllowedMediaUrl(catalogue, id, url)

  test("the URLs the providers actually build are allowed", () => {
    for (const url of [
      "https://i.giphy.com/media/abc123/200w.gif",
      "https://media3.giphy.com/media/abc123/giphy.gif",
      "https://giphy.com/gifs/cat-15UbO1LY4O2Fxw8gnI"
    ]) {
      assert.ok(allowed("giphy", url), `${url} should be allowed for giphy`)
      assert.ok(allowed("giphy-keyless", url), `${url} should be allowed for giphy-keyless`)
    }
    for (const url of [
      "https://media.tenor.com/sXrVe29tNJwAAAAM/cat-gun.gif",
      "https://c.tenor.com/abc/tenor.gif",
      "https://tenor.com/view/cat-gun-gif-12345"
    ]) {
      assert.ok(allowed("tenor", url), `${url} should be allowed for tenor`)
      assert.ok(allowed("tenor-keyless", url), `${url} should be allowed for tenor-keyless`)
    }
  })

  test("a provider's hosts do not carry over to another provider", () => {
    assert.equal(allowed("giphy", "https://media.tenor.com/x/cat.gif"), false)
    assert.equal(allowed("tenor-keyless", "https://i.giphy.com/abc.gif"), false)
  })

  test("plain http is refused even on the right host", () => {
    assert.equal(allowed("giphy", "http://i.giphy.com/abc.gif"), false)
    assert.equal(allowed("giphy", "//i.giphy.com/abc.gif"), false)
    assert.equal(allowed("giphy", "file:///etc/passwd"), false)
  })

  test("a host that merely ends in the right letters is refused", () => {
    // notgiphy.com is not a subdomain of giphy.com, and the suffix check is
    // the easy thing to get wrong here.
    assert.equal(allowed("giphy", "https://notgiphy.com/abc.gif"), false)
    assert.equal(allowed("giphy", "https://giphy.com.evil.example/abc.gif"), false)
    assert.equal(allowed("tenor", "https://tenor.com.evil.example/x.gif"), false)
  })

  test("credentials and ports cannot disguise the real host", () => {
    assert.equal(allowed("giphy", "https://giphy.com@evil.example/abc.gif"), false)
    assert.equal(allowed("giphy", "https://user:pw@evil.example/abc.gif"), false)
    // The host is still giphy.com when a port is on it.
    assert.equal(allowed("giphy", "https://i.giphy.com:443/abc.gif"), true)
  })

  test("nothing, and nonsense, are refused", () => {
    for (const url of ["", "   ", null, undefined, "not a url", "https://"]) {
      assert.equal(allowed("giphy", url), false, `${url} should be refused`)
    }
  })

  test("a provider with no mediaHosts allows nothing", () => {
    assert.equal(allowed("nonexistent", "https://i.giphy.com/abc.gif"), false)
  })
})

describe("keyless URL building", () => {
  const url = (term) => modules["giphy-keyless"].searchUrl("", {}, term, 40, "")

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
    assert.equal(modules["giphy-keyless"].searchUrl("", {}, "cat", 40, "25"), "")
  })
})

describe("keyless parse failure modes", () => {
  test("a page with no results explains itself rather than looking empty", () => {
    const parsed = modules["giphy-keyless"].parse(
      "<html><body>giphy.com and nothing else</body></html>",
      ""
    )
    assert.equal(parsed.items.length, 0)
    assert.match(parsed.error, /layout/i)
  })

  test("a response that is not a Giphy page is reported differently", () => {
    const parsed = modules["giphy-keyless"].parse("<html>nope</html>", "")
    assert.equal(parsed.items.length, 0)
    assert.match(parsed.error, /unreadable|rate limiting/i)
  })

  test("empty and null bodies do not throw", () => {
    for (const raw of ["", null, undefined]) {
      const parsed = modules["giphy-keyless"].parse(raw, "")
      assert.equal(parsed.items.length, 0)
      assert.ok(parsed.error)
    }
  })
})
