// Loads the plugin's real provider code into node.
//
// Providers.js and providers/*.js are QML JavaScript resources: plain ES5 with
// a `.import` header that only the QML engine understands. Stripping that
// header is the entire difference between what QML loads and what node runs,
// so these tests exercise the shipped files rather than a copy that can drift
// away from them.
//
// The sources are evaluated in a vm context because QML JS declares everything
// at top level with `var` and `function` — in a sloppy-mode context those land
// as properties of the context object, which hands us every function the file
// defines without naming them here one by one.

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import vm from "node:vm"

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const IMPORT_HEADER = /^\s*\.import\s.*$/gm

function evaluate(relPath, bindings) {
  const source = readFileSync(join(ROOT, relPath), "utf8").replace(IMPORT_HEADER, "")
  const context = vm.createContext({ ...bindings })
  vm.runInContext(source, context, { filename: relPath })
  return context
}

// `.import "providers/Giphy.js" as GiphyModule` — the header the QML engine
// reads and node does not.
const IMPORT_LINE = /^\s*\.import\s+"([^"]+)"\s+as\s+([A-Za-z_$][\w$]*)\s*$/gm

// The bindings Providers.js's `.import` header would have supplied, read from
// that header rather than restated here — a list kept by hand drifts the
// moment someone adds a provider, and the failure looks like a broken registry
// rather than a stale test.
function importedModules() {
  const source = readFileSync(join(ROOT, "Providers.js"), "utf8")
  const bindings = {}
  for (const [, path, binding] of source.matchAll(IMPORT_LINE)) {
    bindings[binding] = evaluate(path)
  }
  return bindings
}

// Every provider module, keyed by the id it declares.
export function loadModules() {
  const byId = {}
  for (const module of Object.values(importedModules())) {
    if (module.id) byId[module.id] = module
  }
  return byId
}

export function loadProviders() {
  return evaluate("Providers.js", importedModules())
}

export function loadCatalogue() {
  return JSON.parse(readFileSync(join(ROOT, "providers/index.json"), "utf8"))
}

// ------------------------------------------------------------------ network

// These are integration tests: they are supposed to fail when a service
// changes shape, and not to fail because a runner blinked. Retries separate
// the two — a transient 5xx or a dropped connection gets another go, and only
// a repeated failure is reported.
const ATTEMPTS = 3
const BACKOFF_MS = 2000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function fetchText(url, { attempts = ATTEMPTS } = {}) {
  let last
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20000) })
      const body = await response.text()
      // 4xx is the service answering deliberately — a bad key, a blocked
      // scraper — and repeating it just wastes the runner's time. The body is
      // returned either way because that is where the service explains itself,
      // which is exactly what the parsers are written to read.
      if (response.ok || (response.status >= 400 && response.status < 500)) {
        return { status: response.status, body }
      }
      last = new Error(`HTTP ${response.status} from ${url}`)
    } catch (error) {
      last = error
    }
    if (attempt < attempts) await sleep(BACKOFF_MS * attempt)
  }
  throw last
}

// Used to confirm the URLs a provider builds are real. HEAD is enough and
// avoids pulling megabytes of GIF onto the runner.
export async function headStatus(url, { attempts = ATTEMPTS } = {}) {
  let last
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        method: "HEAD",
        signal: AbortSignal.timeout(20000)
      })
      if (response.status < 500) {
        return { status: response.status, type: response.headers.get("content-type") || "" }
      }
      last = new Error(`HTTP ${response.status} from ${url}`)
    } catch (error) {
      last = error
    }
    if (attempt < attempts) await sleep(BACKOFF_MS * attempt)
  }
  throw last
}

// ------------------------------------------------------------------ shared

// The flat shape every provider must produce, per providers/README.md. A
// service that quietly stops supplying one of these fields is precisely the
// breaking change this suite exists to catch.
export function assertItemShape(assert, item, { requireDimensions = true } = {}) {
  assert.ok(item, "item is present")
  for (const field of ["id", "previewUrl", "gifUrl", "pageUrl"]) {
    assert.equal(typeof item[field], "string", `${field} is a string`)
    assert.ok(item[field].length > 0, `${field} is not empty`)
  }
  assert.equal(typeof item.title, "string", "title is a string")
  for (const url of [item.previewUrl, item.gifUrl, item.pageUrl]) {
    assert.match(url, /^https:\/\//, `${url} is https`)
  }
  if (requireDimensions) {
    assert.ok(item.width > 0, `width is positive (got ${item.width})`)
    assert.ok(item.height > 0, `height is positive (got ${item.height})`)
  }
}
