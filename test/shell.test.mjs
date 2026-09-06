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
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, statSync, readFileSync } from "node:fs"
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

function configHome(config) {
  const dir = mkdtempSync(join(tmpdir(), "omagif-config-"))
  mkdirSync(join(dir, "omagif"))
  writeFileSync(join(dir, "omagif", "config.json"), JSON.stringify(config, null, 2))
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
    const { stdout } = run(link, ["doctor"], { env: { ...process.env, XDG_CONFIG_HOME: home } })
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
    const { stdout } = run(link, ["doctor"], { env: { ...process.env, XDG_CONFIG_HOME: home } })
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
      { env: { ...process.env, XDG_CONFIG_HOME: home }, input: "" }
    )
    assert.notEqual(status, 0, `setup accepted an unknown provider:\n${stdout}${stderr}`)
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
