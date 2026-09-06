// Smoke tests for the shell scripts.
//
// The provider tests cover the JavaScript the picker runs; nothing covered
// `bin/omagif` or `setup` until a real bug got through: the CLI took the
// dirname of ${BASH_SOURCE[0]} without resolving symlinks, so running it as
// `omagif` — through the ~/.local/bin link that `omagif install` creates —
// put ROOT_DIR at ~/.local. `omagif setup` died on a path that did not exist,
// and `omagif doctor` silently listed no providers at all.
//
// These run anywhere: no omarchy, no Wayland, no network. `doctor` reports
// missing dependencies on a bare runner and exits non-zero, so the assertions
// look at what it printed rather than at its exit code.

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  mkdtempSync, mkdirSync, symlinkSync, writeFileSync, statSync, readFileSync, chmodSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ROOT } from "./harness.mjs"

const SCRIPTS = ["setup", "bin/omagif"]

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", timeout: 30000, ...options })
}

describe("shell scripts", () => {
  for (const script of SCRIPTS) {
    test(`${script} parses`, () => {
      const { status, stderr } = run("bash", ["-n", join(ROOT, script)])
      assert.equal(status, 0, `bash -n ${script} failed:\n${stderr}`)
    })

    test(`${script} is executable`, () => {
      // Cloned by `omarchy plugin add`, then run directly. Losing the bit
      // makes the plugin uninstallable in a way nothing else would catch.
      const mode = statSync(join(ROOT, script)).mode
      assert.ok(mode & 0o111, `${script} is not executable (mode ${(mode & 0o777).toString(8)})`)
    })
  }
})

// Builds the layout `omagif install` creates: a symlink in some bin directory
// pointing at the script inside the plugin checkout.
function linkedCli() {
  const dir = mkdtempSync(join(tmpdir(), "omagif-cli-"))
  const bin = join(dir, "bin")
  mkdirSync(bin)
  const link = join(bin, "omagif")
  symlinkSync(join(ROOT, "bin/omagif"), link)
  return { dir, link }
}

// `setup` gates on curl, python3, wl-copy and wtype. The Wayland two are not
// on a CI runner, so without stubs setup aborts at that gate and every test
// below it passes or fails for a reason that has nothing to do with what it
// claims to check. Stubbing makes these hermetic: they exercise setup's own
// logic rather than the host's package set.
// notify-send is stubbed for a different reason than the Wayland pair: it is
// not a gate, it works fine, and that is the problem — bin/omagif-action pops a
// real desktop notification on every failure, and the failures below are
// deliberate. The stub shadows the real one for the length of a test.
function pathWithStubbedDeps() {
  const dir = mkdtempSync(join(tmpdir(), "omagif-bin-"))
  for (const tool of ["wl-copy", "wtype", "notify-send"]) {
    const file = join(dir, tool)
    writeFileSync(file, "#!/bin/sh\nexit 0\n")
    chmodSync(file, 0o755)
  }
  return `${dir}:${process.env.PATH}`
}

function configHome(config) {
  const dir = mkdtempSync(join(tmpdir(), "omagif-config-"))
  mkdirSync(join(dir, "omagif"))
  writeFileSync(join(dir, "omagif", "config.json"), JSON.stringify(config, null, 2))
  return dir
}

// An isolated state directory. Every `doctor` call needs one: doctor reads the
// remembered provider from XDG_STATE_HOME, so a test that leaves it unset
// reads the developer's own swap and passes or fails according to whatever
// they last pressed Ctrl+P on.
function stateHome(saved) {
  const dir = mkdtempSync(join(tmpdir(), "omagif-state-"))
  mkdirSync(join(dir, "omagif"))
  if (saved) {
    writeFileSync(join(dir, "omagif", "provider.json"), JSON.stringify({ provider: saved }))
  }
  return dir
}

describe("the CLI works through its symlink", () => {
  test("`omagif setup` finds setup instead of a path beside the link", () => {
    const { link } = linkedCli()
    const { status, stdout, stderr } = run(link, ["setup", "--help"])
    assert.doesNotMatch(
      stderr,
      /No such file or directory/,
      `the CLI resolved ROOT_DIR from the symlink rather than its target:\n${stderr}`
    )
    assert.match(stdout, /Usage: \.\/setup/, `unexpected output:\n${stdout}${stderr}`)
    assert.equal(status, 0)
  })

  test("`omagif doctor` finds the provider catalogue", () => {
    const { link } = linkedCli()
    const home = configHome({ provider: "giphy-keyless", "giphy-keyless": {} })
    // doctor exits non-zero on a runner with no wl-copy/wtype/omarchy, so the
    // check is on what it printed. With ROOT_DIR wrong the catalogue read
    // yields nothing and no provider line is emitted at all.
    const { stdout } = run(link, ["doctor"], {
      env: { ...process.env, XDG_CONFIG_HOME: home, XDG_STATE_HOME: stateHome() }
    })
    assert.match(stdout, /provider giphy-keyless/, `doctor did not read the config:\n${stdout}`)
    assert.match(
      stdout,
      /giphy-keyless needs no key/,
      `doctor listed no providers — ROOT_DIR is probably not the plugin directory:\n${stdout}`
    )
    assert.match(stdout, /\btenor\b/, `tenor missing from doctor's provider list:\n${stdout}`)
  })

  test("doctor does not call a keyless provider's missing key a fault", () => {
    const { link } = linkedCli()
    const home = configHome({ provider: "giphy-keyless", "giphy-keyless": {} })
    const { stdout } = run(link, ["doctor"], {
      env: { ...process.env, XDG_CONFIG_HOME: home, XDG_STATE_HOME: stateHome() }
    })
    // Assert the line exists before asserting what it does not say — with no
    // catalogue at all there is no "absent" line either, and this would pass
    // for entirely the wrong reason.
    assert.match(
      stdout,
      /giphy-keyless needs no key/,
      `doctor listed no providers, so this test proves nothing:\n${stdout}`
    )
    assert.doesNotMatch(
      stdout,
      /absent\s+giphy-keyless key/,
      `a keyless provider was reported as missing a key:\n${stdout}`
    )
  })
})

describe("setup", () => {
  test("--help works without a terminal or any config", () => {
    const { status, stdout } = run("bash", [join(ROOT, "setup"), "--help"])
    assert.equal(status, 0)
    assert.match(stdout, /--provider <id>/)
  })

  test("an unknown provider is refused rather than half-configured", () => {
    const home = configHome({})
    const { status, stdout, stderr } = run(
      "bash",
      [join(ROOT, "setup"), "--provider", "nope"],
      {
        env: { ...process.env, XDG_CONFIG_HOME: home, PATH: pathWithStubbedDeps() },
        input: ""
      }
    )
    assert.notEqual(status, 0, `setup accepted an unknown provider:\n${stdout}${stderr}`)
  })
})

// Ctrl+P writes the provider it swapped to into the state directory, and the
// picker prefers it over the config. The rule that makes that safe is that
// choosing a service in setup outranks it — without which setup would appear
// to do nothing for anyone who had ever pressed Ctrl+P.
describe("the remembered provider", () => {
  const config = { provider: "giphy", giphy: { apiKey: "kkkkkkkk" }, limit: 40, columns: 4 }

  test("doctor reports the config's provider when nothing was swapped", () => {
    const { link } = linkedCli()
    const env = { ...process.env, XDG_CONFIG_HOME: configHome(config), XDG_STATE_HOME: stateHome() }
    const { stdout } = run(link, ["doctor"], { env })
    assert.match(stdout, /provider giphy\b/)
    assert.doesNotMatch(stdout, /swapped with Ctrl\+P/)
  })

  test("doctor reports a swap, and says what the config still holds", () => {
    const { link } = linkedCli()
    const env = {
      ...process.env,
      XDG_CONFIG_HOME: configHome(config),
      XDG_STATE_HOME: stateHome("tenor-keyless")
    }
    const { stdout } = run(link, ["doctor"], { env })
    assert.match(stdout, /provider tenor-keyless \(swapped with Ctrl\+P; giphy in config\)/)
  })

  test("setup drops the remembered swap when it writes a provider", () => {
    const configDir = configHome(config)
    const stateDir = stateHome("tenor-keyless")
    const saved = join(stateDir, "omagif", "provider.json")
    assert.doesNotThrow(() => statSync(saved), "fixture did not create the state file")

    const { status } = run("bash", [join(ROOT, "setup"), "--provider", "giphy-keyless"], {
      env: {
        ...process.env,
        XDG_CONFIG_HOME: configDir,
        XDG_STATE_HOME: stateDir,
        PATH: pathWithStubbedDeps()
      },
      input: "y\nn\nn\nn\nn\nn\n"
    })
    assert.equal(status, 0)
    assert.throws(
      () => statSync(saved),
      "setup wrote a provider but left the remembered swap in place, so it would be ignored"
    )
  })

  test("a malformed state file does not break doctor", () => {
    const dir = mkdtempSync(join(tmpdir(), "omagif-state-"))
    mkdirSync(join(dir, "omagif"))
    writeFileSync(join(dir, "omagif", "provider.json"), "{not json")
    const { link } = linkedCli()
    const { stdout } = run(link, ["doctor"], {
      env: { ...process.env, XDG_CONFIG_HOME: configHome(config), XDG_STATE_HOME: dir }
    })
    assert.match(stdout, /provider giphy\b/, `doctor did not fall back cleanly:\n${stdout}`)
  })
})

// `omagif install` is the only thing here that writes outside the plugin's own
// checkout, into two names it does not own: ~/.local/bin/omagif and a desktop
// entry. Replacing someone else's file at either is not ours to do silently.
describe("install refuses to take over what it does not own", () => {
  const CLI = join(ROOT, "bin/omagif")

  function fakeHome() {
    return mkdtempSync(join(tmpdir(), "omagif-home-"))
  }

  function install(home, args = []) {
    return run("bash", [CLI, "install", ...args], {
      env: { ...process.env, HOME: home, PATH: pathWithStubbedDeps() }
    })
  }

  const link = (home) => join(home, ".local/bin/omagif")
  const entry = (home) => join(home, ".local/share/applications/omagif.desktop")

  test("a clean home gets the link and the desktop entry", () => {
    const home = fakeHome()
    const { status, stdout } = install(home)
    assert.equal(status, 0, `install failed:\n${stdout}`)
    assert.equal(
      statSync(link(home)).isFile() || statSync(link(home)).isSymbolicLink(),
      true
    )
    assert.match(readFileSync(entry(home), "utf8"), /X-Omagif-Plugin=/)
  })

  test("running it twice is fine — the second run owns what the first wrote", () => {
    const home = fakeHome()
    assert.equal(install(home).status, 0)
    const { status, stdout, stderr } = install(home)
    assert.equal(status, 0, `a re-install refused its own files:\n${stdout}${stderr}`)
  })

  test("someone else's omagif on PATH is left exactly as it was", () => {
    const home = fakeHome()
    mkdirSync(join(home, ".local/bin"), { recursive: true })
    writeFileSync(link(home), "#!/bin/sh\necho not ours\n")

    const { status, stderr } = install(home)
    assert.notEqual(status, 0, "install reported success after refusing to write")
    assert.match(stderr, /--force/, `the refusal should say how to override it:\n${stderr}`)
    assert.equal(
      readFileSync(link(home), "utf8"),
      "#!/bin/sh\necho not ours\n",
      "install overwrote a file it does not own"
    )
  })

  test("a desktop entry without our marker is left alone", () => {
    const home = fakeHome()
    mkdirSync(join(home, ".local/share/applications"), { recursive: true })
    writeFileSync(entry(home), "[Desktop Entry]\nName=Someone else\n")

    const { status, stderr } = install(home)
    assert.notEqual(status, 0)
    assert.doesNotMatch(readFileSync(entry(home), "utf8"), /X-Omagif-Plugin=/)
    assert.match(stderr, /omagif\.desktop/)
  })

  test("--force is the way to say yes, take it", () => {
    const home = fakeHome()
    mkdirSync(join(home, ".local/bin"), { recursive: true })
    writeFileSync(link(home), "#!/bin/sh\necho not ours\n")

    const { status } = install(home, ["--force"])
    assert.equal(status, 0)
    assert.notEqual(readFileSync(link(home), "utf8"), "#!/bin/sh\necho not ours\n")
  })
})

// Every URL the picker acts on came out of a remote response. bin/omagif-action
// is the boundary where one stops being text, so it re-checks scheme and host
// itself rather than trusting the caller — it is reachable from a shell too.
describe("omagif-action refuses a URL it was not meant to fetch", () => {
  const ACTION = join(ROOT, "bin/omagif-action")

  function act(url) {
    const cache = mkdtempSync(join(tmpdir(), "omagif-cache-"))
    return run("bash", [ACTION, "cache", url, cache], {
      env: { ...process.env, PATH: pathWithStubbedDeps() }
    })
  }

  // Each of these would be a request to somewhere the catalogue never named.
  // None of them reach the network: the gate runs before any verb does.
  for (const url of [
    "http://i.giphy.com/abc.gif",
    "https://evil.example/abc.gif",
    "https://notgiphy.com/abc.gif",
    "https://giphy.com.evil.example/abc.gif",
    "https://giphy.com@evil.example/abc.gif",
    "file:///etc/passwd",
    "ftp://giphy.com/abc.gif"
  ]) {
    test(`refuses ${url}`, () => {
      const { status, stderr } = act(url)
      assert.notEqual(status, 0, `${url} was accepted`)
      assert.match(stderr, /refused a URL/, `unexpected failure for ${url}:\n${stderr}`)
    })
  }

  test("an unknown verb is still refused before anything else", () => {
    const { status } = run("bash", [ACTION, "wat", "https://i.giphy.com/abc.gif"], {
      env: { ...process.env, PATH: pathWithStubbedDeps() }
    })
    assert.equal(status, 64)
  })
})

describe("shipped JSON is valid", () => {
  for (const file of ["providers/index.json", "omagif.example.json", "manifest.json"]) {
    test(file, () => {
      const raw = readFileSync(join(ROOT, file), "utf8")
      assert.doesNotThrow(() => JSON.parse(raw), `${file} is not valid JSON`)
    })
  }

  test("manifest entry points exist", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"))
    for (const path of Object.values(manifest.entryPoints || {})) {
      assert.doesNotThrow(
        () => statSync(join(ROOT, path)),
        `manifest.json names "${path}", which is not in the repo`
      )
    }
  })
})
