import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import QtQuick
import qs.Commons
import qs.Ui
import "Providers.js" as Providers

// Omagif — a GIF picker overlay in the shape of the built-in emoji picker.
// Type to search, arrow around an animated grid, and hit Enter
// to put the GIF on the clipboard. All side effects (downloading, wl-copy,
// wtype, saving) live in bin/omagif-action so this file stays UI.
Item {
  id: root

  property string home: Quickshell.env("HOME")
  property var shell: null
  property var manifest: null

  readonly property string pluginId: (manifest && manifest.id) || "stoneynutcase.omagif"
  readonly property string sourceDir: (manifest && manifest.__sourceDir)
    || (home + "/.config/omarchy/plugins/stoneynutcase.omagif")
  readonly property string actionBin: sourceDir + "/bin/omagif-action"
  readonly property string configPath: (Quickshell.env("XDG_CONFIG_HOME") || (home + "/.config")) + "/omagif/config.json"
  readonly property string stateDir: (Quickshell.env("XDG_STATE_HOME") || (home + "/.local/state")) + "/omagif"
  readonly property string configDir: (Quickshell.env("XDG_CONFIG_HOME") || (home + "/.config")) + "/omagif"

  property bool opened: false
  property string filterText: ""
  property int selectedIndex: 0
  property bool cursorActive: false
  // The query is a plain Text with hand-rolled key handling rather than a
  // TextField — a real one would fight the grid over the arrow keys. Tab
  // "selects" the query the way a text field would: it highlights, and the
  // next keystroke replaces it instead of appending.
  property bool filterSelected: false

  // ----------------------------------------------------------- search history
  // Most recent first. Ctrl+Up/Ctrl+Down walk it — the plain arrows belong to
  // the grid. historyIndex is -1 when not browsing; historyDraft holds the
  // query that was being typed when browsing started, so Ctrl+Down can put it
  // back. Set historyLimit to 0 in the config to keep no history at all.
  property var history: []
  property int historyIndex: -1
  property string historyDraft: ""
  // Transient status-line message, e.g. after Ctrl+Delete.
  property string flashMessage: ""
  readonly property int historyLimit: {
    var n = parseInt(root.config && root.config.historyLimit, 10)
    return isNaN(n) ? 50 : Math.max(0, Math.min(500, n))
  }

  // ------------------------------------------------------------------ config
  property var config: ({})
  // Ctrl+P swaps providers for the session without rewriting the config file;
  // `provider` in omagif.json stays the durable choice.
  property string providerOverride: ""
  // The parsed providers/index.json — the catalogue of what exists, what is
  // still offered, and where to get a key. Loaded from disk so a provider can
  // be added or retired without touching this file.
  property var catalogue: ({})
  readonly property string provider: providerOverride || Providers.providerName(config, catalogue)
  readonly property string providerLabel: Providers.providerLabel(catalogue, provider)
  readonly property bool configured: Providers.apiKey(config, provider).length > 0
  // Ids offered on the first-run screen: enabled in the catalogue, or already
  // holding a key.
  readonly property var setupProviders: Providers.usableProviders(config, catalogue)
  readonly property string swapTarget: Providers.nextProvider(config, catalogue, provider)
  readonly property bool canSwapProvider: swapTarget.length > 0
  readonly property string cacheDir: Providers.cacheDir(config, home)
  readonly property string saveDir: Providers.saveDir(config, home)
  // What plain Enter does; the modifier variants are always available.
  readonly property string enterVerb: Providers.enterAction(config)

  // ------------------------------------------------------------------ results
  property var items: []
  // previewUrl -> locally cached file, filled in only when the remote load
  // fails. Kept outside `items` so a thumbnail landing never rebuilds the
  // model and restarts every animation in the grid.
  property var previewCache: ({})
  property string nextCursor: ""
  property bool loading: false
  property bool appending: false
  property string errorText: ""
  property bool searchQueued: false

  // ------------------------------------------------------------------- theme
  // Shares the [menu] surface tokens, so a theme that styles the launcher and
  // the emoji picker styles this too.
  property color background: Color.menu.background
  property color foreground: Color.menu.text
  property color border: Color.menu.border
  property var borderSpec: Border.surfaceSpec("menu", "border", border, Math.max(1, Style.space(2)))
  property color scrim: Color.menu.scrim
  property color selectedBackground: Color.menu.selectedBackground
  property color selectedText: Color.menu.selectedText
  readonly property int cornerRadius: Style.cornerRadius
  property string fontFamily: Style.font.menuFamily
  property int contentMargin: Style.spacing.panelPadding
  property int contentSpacing: Style.spacing.md
  property int headerHeight: Math.max(Style.space(34), Style.font.heading + Style.spacing.controlPaddingY * 2)
  property int footerHeight: Math.max(Style.space(20), Style.font.caption + Style.spacing.xs * 2)

  property int cardWidth: Math.min(Style.space(760), panel.width - Style.gapsOut * 2)
  property int cardHeight: Math.min(Style.space(560), panel.height - Style.gapsOut * 2)

  readonly property int columns: Providers.columns(config)
  readonly property int cellWidth: gridArea.width > 0
    ? Math.floor(gridArea.width / columns)
    : Style.space(160)
  readonly property int cellHeight: Math.round(cellWidth * 0.72)
  readonly property int cellPadding: Style.spacing.xs

  // ------------------------------------------------------------- lifecycle
  function open(payloadJson) {
    root.opened = true
    // Cheap, and it closes the gap for good: whatever the watcher did or did
    // not notice while we were closed, opening re-reads the config. onLoaded
    // re-runs the search, so a key added since last time takes effect here.
    configFile.reload()
    root.filterSelected = false
    root.flashMessage = ""
    root.cursorActive = root.items.length > 0
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
    // Trending goes stale and a key may have been added since last time.
    if (root.items.length === 0 || root.errorText) root.requestSearch()
  }

  function close() {
    root.rememberQuery()
    root.opened = false
  }

  function dismiss() {
    root.rememberQuery()
    root.opened = false
    if (root.shell && typeof root.shell.hide === "function") root.shell.hide(root.pluginId)
  }

  function toggle() {
    if (root.opened) root.dismiss()
    else root.open("{}")
  }

  // --------------------------------------------------------------- searching
  function setFilter(nextFilter) {
    root.filterText = nextFilter
    root.filterSelected = false
    root.exitHistory()
    debounce.restart()
  }

  function clearFilter() {
    root.filterText = ""
    root.filterSelected = false
    root.exitHistory()
    debounce.stop()
    root.requestSearch()
  }

  function selectFilter() {
    if (!root.filterText) return
    root.filterSelected = true
  }

  // ----------------------------------------------------------------- history
  function loadHistory(raw) {
    var parsed = []
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      parsed = []
    }
    if (!Array.isArray(parsed)) parsed = []
    var out = []
    for (var i = 0; i < parsed.length && out.length < root.historyLimit; i++) {
      var entry = String(parsed[i] || "").trim()
      if (entry && out.indexOf(entry) === -1) out.push(entry)
    }
    root.history = out
  }

  // Recorded when the picker closes, not on every keystroke — otherwise every
  // prefix of every word ("m", "mo", "mon", "monk") would end up in here. A
  // query that found nothing isn't worth remembering either.
  function rememberQuery() {
    if (root.historyLimit === 0) return
    var query = root.filterText.trim()
    if (!query || root.items.length === 0) return
    if (root.history.length > 0 && root.history[0] === query) return

    var next = [query]
    for (var i = 0; i < root.history.length && next.length < root.historyLimit; i++) {
      if (root.history[i] !== query) next.push(root.history[i])
    }
    root.history = next
    historyFile.setText(JSON.stringify(next, null, 2) + "\n")
  }

  // Applies a remembered query without leaving history-browsing mode, which
  // setFilter would do.
  function applyHistoryText(text) {
    root.filterText = text
    root.filterSelected = false
    debounce.restart()
  }

  function historyStep(older) {
    if (root.history.length === 0) return

    if (root.historyIndex === -1) {
      if (!older) return              // nothing newer than what you're typing
      root.historyDraft = root.filterText
      root.historyIndex = 0
    } else if (older) {
      if (root.historyIndex >= root.history.length - 1) return   // oldest entry
      root.historyIndex++
    } else if (root.historyIndex === 0) {
      root.historyIndex = -1                                     // back to the draft
      root.applyHistoryText(root.historyDraft)
      return
    } else {
      root.historyIndex--
    }
    root.applyHistoryText(root.history[root.historyIndex])
  }

  // Anything that isn't a history step ends the walk, leaving the text where
  // it landed.
  function exitHistory() {
    root.historyIndex = -1
  }

  function clearHistory() {
    root.historyIndex = -1
    root.historyDraft = ""
    if (root.history.length === 0) {
      root.flash("No history to clear")
      return
    }
    root.history = []
    historyFile.setText("[]\n")
    root.flash("History cleared")
  }

  // Wiping history has no visible result of its own — the query stays, the
  // grid stays — so say so in the status line for a moment.
  function flash(message) {
    root.flashMessage = message
    flashTimer.restart()
  }

  // Fresh search for the current filter. One curl at a time: a request that
  // arrives while another is in flight is queued and fired on exit, so fast
  // typing costs one extra round trip rather than a pile of racing ones.
  function requestSearch() {
    root.nextCursor = ""
    root.errorText = ""
    if (searchProc.running) {
      root.searchQueued = true
      return
    }
    root.startSearch(false)
  }

  function loadMore() {
    if (!root.nextCursor || searchProc.running || !root.configured) return
    root.startSearch(true)
  }

  function startSearch(append) {
    if (!root.configured) {
      root.items = []
      root.loading = false
      return
    }
    var url = Providers.searchUrl(config, root.provider, root.filterText.trim(), append ? root.nextCursor : "")
    if (!url) return
    root.appending = append
    root.loading = true
    // --fail-with-body, not -f: both make an HTTP error a non-zero exit, but
    // -f also discards the response, and the response is where the service
    // explains itself ("Unauthorized", "rate limit exceeded"). curl's own
    // error goes to stderr, which we do not collect, so stdout stays JSON.
    searchProc.command = ["curl", "-sS", "--fail-with-body", "--max-time", "12", url]
    searchProc.running = true
  }

  // curl exit codes are diagnostic, not something to put in front of a
  // person. These are the ones a GIF search realistically hits.
  function curlMessage(exitCode) {
    if (exitCode === 6) return "Can\u2019t reach " + providerLabel + " \u2014 you appear to be offline"
    if (exitCode === 7) return "Can\u2019t connect to " + providerLabel
    if (exitCode === 28) return providerLabel + " took too long to answer"
    if (exitCode === 35 || exitCode === 60) return "Secure connection to " + providerLabel + " failed"
    return "Couldn\u2019t reach " + providerLabel + " (curl error " + exitCode + ")"
  }

  function applyResults(raw, exitCode) {
    var append = root.appending
    var cursorAtStart = append ? root.nextCursor : ""

    if (exitCode !== 0 || !raw) {
      if (!append) root.items = []
      // An HTTP error still carries the service's own JSON, which explains the
      // failure better than anything we could guess at.
      var parsed = raw ? Providers.parse(root.provider, raw, cursorAtStart) : null
      var reported = parsed ? parsed.error : ""
      var status = parsed && parsed.status ? parsed.status : 0
      if (exitCode === 22) {
        var base = reported ? providerLabel + ": " + reported
                            : providerLabel + " rejected the request"
        // Being over quota is not a reason to go looking at your API key.
        if (status === 429) root.errorText = base + " — try again in a minute"
        else if (status === 0 || status === 401 || status === 403)
          root.errorText = base + " — check the API key in " + shortConfigPath()
        else root.errorText = base
      } else {
        root.errorText = reported || root.curlMessage(exitCode)
      }
      return
    }

    var parsed = Providers.parse(root.provider, raw, cursorAtStart)
    if (parsed.error) {
      if (!append) root.items = []
      root.errorText = parsed.error
      return
    }

    root.errorText = ""
    root.nextCursor = parsed.next
    if (append) {
      root.items = root.items.concat(parsed.items)
      return
    }

    root.items = parsed.items
    root.selectedIndex = 0
    root.cursorActive = parsed.items.length > 0
    Qt.callLater(function() { resultGrid.positionViewAtBeginning() })
  }

  function shortConfigPath() {
    return "~/.config/omagif/config.json"
  }

  function notePreview(url, path) {
    if (!url || !path) return
    var next = ({})
    for (var k in root.previewCache) next[k] = root.previewCache[k]
    next[url] = path
    root.previewCache = next
  }

  // ---------------------------------------------------------------- movement
  // Moving the grid cursor means you are no longer about to retype the query.
  function select(delta) {
    root.filterSelected = false
    root.exitHistory()
    if (root.items.length === 0) return
    if (!root.cursorActive) {
      root.cursorActive = true
      root.selectedIndex = delta < 0 ? root.items.length - 1 : 0
    } else {
      root.selectedIndex = (root.selectedIndex + delta + root.items.length) % root.items.length
    }
    resultGrid.positionViewAtIndex(root.selectedIndex, GridView.Contain)
  }

  function selectBy(step) {
    root.filterSelected = false
    root.exitHistory()
    if (root.items.length === 0) return
    if (!root.cursorActive) {
      root.cursorActive = true
      root.selectedIndex = step < 0 ? root.items.length - 1 : 0
    } else {
      root.selectedIndex = Math.max(0, Math.min(root.items.length - 1, root.selectedIndex + step))
    }
    resultGrid.positionViewAtIndex(root.selectedIndex, GridView.Contain)
  }

  function selectEdge(toEnd) {
    root.filterSelected = false
    root.exitHistory()
    if (root.items.length === 0) return
    root.cursorActive = true
    root.selectedIndex = toEnd ? root.items.length - 1 : 0
    resultGrid.positionViewAtIndex(root.selectedIndex, GridView.Contain)
  }

  function visibleRows() {
    return Math.max(1, Math.floor(resultGrid.height / Math.max(1, root.cellHeight)))
  }

  // ----------------------------------------------------------------- actions
  function currentItem() {
    if (!root.cursorActive) return null
    if (root.selectedIndex < 0 || root.selectedIndex >= root.items.length) return null
    return root.items[root.selectedIndex]
  }

  // Every verb is a one-shot script run detached: the overlay closes first so
  // the paste lands in whatever window had focus before it opened.
  function runAction(verb) {
    var item = root.currentItem()
    if (!item) return
    // Sharing and downloading want different URLs for the same GIF — see
    // Providers.urlFor.
    var url = Providers.urlFor(item, verb, root.config, root.provider)
    if (!url) return
    root.dismiss()
    Quickshell.execDetached([
      root.actionBin, verb, url, root.cacheDir, root.saveDir, item.title || ""
    ])
  }

  function swapProvider() {
    if (!root.canSwapProvider) return
    root.providerOverride = root.swapTarget
    root.items = []
    root.requestSearch()
  }

  // ------------------------------------------------------------------- setup
  // Both providers need a free API key and there is no keyless fallback, so
  // the first run has to ask for one. Following the convention the other
  // third-party plugins use, the questions are asked by ./setup in a floating
  // terminal rather than reimplemented as a form in here — it can open a
  // browser, verify the key against the live API, and offer the keybinding.
  function setupPath() {
    return decodeURIComponent(String(Qt.resolvedUrl("setup")).replace(/^file:\/\//, ""))
  }

  function launchSetup(providerId) {
    // The overlay holds exclusive keyboard focus; the terminal is unusable
    // until we let go of it.
    root.dismiss()
    Quickshell.execDetached([
      "omarchy-launch-floating-terminal-with-presentation",
      Util.shellQuote(root.setupPath())
        + (providerId ? " --provider " + Util.shellQuote(providerId) : "")
    ])
  }

  // -------------------------------------------------------------------- data
  FileView {
    id: configFile
    path: root.configPath
    watchChanges: true
    printErrors: false
    // text() is stale inside the change signal, so both paths go through
    // reload → onLoaded and always parse fresh content.
    onFileChanged: reload()
    onLoaded: {
      var parsed = {}
      try {
        parsed = JSON.parse(text())
      } catch (e) {
        parsed = {}
        root.errorText = shortConfigPath() + " is not valid JSON"
      }
      root.config = parsed
      root.providerOverride = ""
      if (root.opened) root.requestSearch()
    }
    onLoadFailed: {
      root.config = ({})
      root.providerOverride = ""
    }
  }

  // Both directories are created at startup, for two different reasons.
  // History writes atomically via a temp file beside the target, so the state
  // directory has to exist before the first query is recorded. The config
  // directory matters even more: a FileView cannot watch a file inside a
  // directory that does not exist, so without this a fresh install would sit
  // there claiming no API key until the next shell restart, however long after
  // setup ran.
  Process {
    id: ensureDirs
    command: ["mkdir", "-p", root.stateDir, root.configDir]
    running: true
  }

  FileView {
    id: historyFile
    path: root.stateDir + "/history.json"
    watchChanges: true
    atomicWrites: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.loadHistory(text())
    onLoadFailed: root.history = []
  }

  // The provider catalogue. Static content shipped with the plugin, but read
  // from disk rather than compiled in, so adding or retiring a provider is a
  // JSON edit plus a module — see providers/README.md.
  FileView {
    id: catalogueFile
    path: root.sourceDir + "/providers/index.json"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      try {
        root.catalogue = JSON.parse(text())
      } catch (e) {
        root.catalogue = ({})
        console.warn("omagif: providers/index.json is not valid JSON")
      }
    }
    onLoadFailed: root.catalogue = ({})
  }

  Timer {
    id: debounce
    interval: 260
    onTriggered: root.requestSearch()
  }

  Timer {
    id: flashTimer
    interval: 1800
    onTriggered: root.flashMessage = ""
  }

  Process {
    id: searchProc
    stdout: StdioCollector { id: searchStdout; waitForEnd: true }
    onExited: function(exitCode) {
      root.loading = false
      root.applyResults(String(searchStdout.text || "").trim(), exitCode)
      if (root.searchQueued) {
        root.searchQueued = false
        root.startSearch(false)
      }
    }
  }

  PanelWindow {
    id: panel
    visible: root.opened
    anchors { top: true; bottom: true; left: true; right: true }
    color: "transparent"
    WlrLayershell.namespace: "omagif"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.Exclusive
    exclusionMode: ExclusionMode.Ignore

    Rectangle {
      anchors.fill: parent
      color: root.scrim
    }

    MouseArea {
      anchors.fill: parent
      onClicked: root.dismiss()
    }

    BorderSurface {
      id: card
      width: root.cardWidth
      height: root.cardHeight
      radius: root.cornerRadius
      anchors.centerIn: parent
      color: root.background
      borderSpec: root.borderSpec
      padding: root.contentMargin

      MouseArea { anchors.fill: parent; onClicked: {} }

      Item {
        id: keyCatcher
        anchors.fill: parent
        focus: true

        Keys.priority: Keys.BeforeItem
        Keys.onPressed: function(event) {
          var ctrl = (event.modifiers & Qt.ControlModifier) !== 0
          var shift = (event.modifiers & Qt.ShiftModifier) !== 0
          var alt = (event.modifiers & Qt.AltModifier) !== 0

          if (event.key === Qt.Key_Escape) {
            if (root.filterSelected) root.filterSelected = false
            else if (root.filterText) root.clearFilter()
            else root.dismiss()
            event.accepted = true
          } else if (event.key === Qt.Key_Tab || event.key === Qt.Key_Backtab) {
            // Accepted either way, so Tab never wanders off into focus
            // navigation and out of the picker.
            root.selectFilter()
            event.accepted = true
          } else if (!ctrl && root.filterSelected
                     && (event.key === Qt.Key_Backspace || event.key === Qt.Key_Delete)) {
            // Plain Delete on a selected query wipes the query; Ctrl+Delete is
            // a different verb entirely, handled below.
            root.setFilter("")
            event.accepted = true
          } else if (ctrl && event.key === Qt.Key_S) {
            root.runAction("save")
            event.accepted = true
          } else if (ctrl && event.key === Qt.Key_P) {
            root.swapProvider()
            event.accepted = true
          } else if (ctrl && event.key === Qt.Key_Comma) {
            root.launchSetup("")
            event.accepted = true
          } else if (ctrl && event.key === Qt.Key_Up) {
            root.historyStep(true)
            event.accepted = true
          } else if (ctrl && event.key === Qt.Key_Down) {
            root.historyStep(false)
            event.accepted = true
          } else if (ctrl && event.key === Qt.Key_Delete) {
            root.clearHistory()
            event.accepted = true
          } else if (ctrl && event.key === Qt.Key_O) {
            root.runAction("open")
            event.accepted = true
          } else if (Util.editsFilter(event, root.filterText)) {
            root.setFilter(Util.editedFilter(event, root.filterText))
            event.accepted = true
          } else if (event.key === Qt.Key_Left) {
            root.select(-1)
            event.accepted = true
          } else if (event.key === Qt.Key_Right) {
            root.select(1)
            event.accepted = true
          } else if (event.key === Qt.Key_Up) {
            root.selectBy(-root.columns)
            event.accepted = true
          } else if (event.key === Qt.Key_Down) {
            root.selectBy(root.columns)
            event.accepted = true
          } else if (event.key === Qt.Key_PageUp) {
            root.selectBy(-root.columns * root.visibleRows())
            event.accepted = true
          } else if (event.key === Qt.Key_PageDown) {
            root.selectBy(root.columns * root.visibleRows())
            event.accepted = true
          } else if (event.key === Qt.Key_Home) {
            root.selectEdge(false)
            event.accepted = true
          } else if (event.key === Qt.Key_End) {
            root.selectEdge(true)
            event.accepted = true
          } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
            if (!root.configured) root.launchSetup("")
            // A failed search leaves nothing to act on, so Enter means "try
            // that again" rather than doing nothing at all.
            else if (root.errorText && root.items.length === 0) root.requestSearch()
            else if (!root.cursorActive && root.items.length > 0) root.cursorActive = true
            else if (ctrl) root.runAction("paste-url")
            else if (shift) root.runAction("copy-url")
            else if (alt) root.runAction("copy-image")
            else root.runAction(root.enterVerb)
            event.accepted = true
          } else if (!ctrl && event.text && event.text.length === 1
                     && event.text.charCodeAt(0) >= 32 && event.text.charCodeAt(0) !== 127) {
            // A selected query is replaced by what you type, not appended to.
            root.setFilter(root.filterSelected ? event.text : root.filterText + event.text)
            event.accepted = true
          }
        }
      }

      Column {
        anchors.fill: parent
        anchors.topMargin: card.contentTopInset
        anchors.rightMargin: card.contentRightInset
        anchors.bottomMargin: card.contentBottomInset
        anchors.leftMargin: card.contentLeftInset
        spacing: root.contentSpacing

        // ------------------------------------------------------------ header
        Item {
          width: parent.width
          height: root.headerHeight

          // Selection highlight behind the query. Painted before the Text so
          // it sits underneath, and clamped to the label's own width so a
          // long query that elides doesn't spill past the status on the right.
          Rectangle {
            visible: root.filterSelected && root.filterText.length > 0
            anchors.left: searchLabel.left
            anchors.leftMargin: -Style.space(3)
            anchors.verticalCenter: searchLabel.verticalCenter
            width: Math.min(searchLabel.paintedWidth + Style.space(6), searchLabel.width)
            height: searchLabel.font.pixelSize + Style.space(6)
            radius: Math.max(1, Math.round(Style.cornerRadius / 2))
            color: Style.selectionFill
          }

          Text {
            id: searchLabel
            textFormat: Text.PlainText
            anchors.left: parent.left
            anchors.right: statusLabel.left
            anchors.rightMargin: Style.spacing.md
            anchors.verticalCenter: parent.verticalCenter
            text: root.filterText || "Search GIFs…"
            color: root.foreground
            opacity: root.filterText ? 1 : 0.58
            font.family: root.fontFamily
            font.pixelSize: Style.font.heading
            elide: Text.ElideRight
          }

          Text {
            id: statusLabel
            textFormat: Text.PlainText
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            text: {
              if (root.flashMessage) return root.flashMessage
              if (root.historyIndex >= 0)
                return "history " + (root.historyIndex + 1) + "/" + root.history.length
              if (root.loading) return "Searching " + root.providerLabel + "…"
              if (root.items.length > 0) return root.providerLabel + " · " + root.items.length
              return root.providerLabel
            }
            color: root.selectedText
            opacity: 0.75
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
          }
        }

        // -------------------------------------------------------------- grid
        Item {
          id: gridArea
          width: parent.width
          height: parent.height - root.headerHeight - root.footerHeight - root.contentSpacing * 2

          GridView {
            id: resultGrid
            anchors.fill: parent
            model: root.items
            visible: root.items.length > 0
            clip: true
            cellWidth: root.cellWidth
            cellHeight: root.cellHeight
            cacheBuffer: root.cellHeight * 2
            boundsBehavior: Flickable.StopAtBounds

            // Endless scroll: the next page is fetched once the last row is
            // in view, in the same one-request-at-a-time lane as searching.
            onContentYChanged: {
              if (contentY + height >= contentHeight - root.cellHeight) root.loadMore()
            }

            delegate: Item {
              id: cell
              required property int index
              required property var modelData

              readonly property bool hasCursor: root.cursorActive && index === root.selectedIndex
              readonly property string localPath: root.previewCache[modelData.previewUrl] || ""

              width: root.cellWidth
              height: root.cellHeight

              Rectangle {
                anchors.fill: parent
                anchors.margins: root.cellPadding
                radius: root.cornerRadius
                color: cell.hasCursor ? root.selectedBackground : Util.alpha(root.foreground, 0.05)
                clip: true

                AnimatedImage {
                  id: preview
                  anchors.fill: parent
                  fillMode: Image.PreserveAspectCrop
                  asynchronous: true
                  cache: true
                  playing: true
                  speed: 1.0
                  source: cell.localPath
                    ? Util.fileUrl(cell.localPath)
                    : (cell.modelData.previewUrl || "")
                  // Qt's network stack occasionally refuses a CDN redirect
                  // where curl is happy; fall back to a cached local copy
                  // rather than showing a hole in the grid.
                  onStatusChanged: {
                    if (status === Image.Error && !cell.localPath && !fetchProc.running)
                      fetchProc.running = true
                  }
                }

                Text {
                  anchors.centerIn: parent
                  visible: preview.status === Image.Loading || preview.status === Image.Null
                  text: "󰋩"
                  color: root.foreground
                  opacity: 0.35
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.display
                }

                Rectangle {
                  anchors.fill: parent
                  visible: cell.hasCursor
                  radius: root.cornerRadius
                  color: "transparent"
                  border.width: Math.max(1, Style.space(2))
                  border.color: root.selectedText
                }
              }

              Process {
                id: fetchProc
                command: [root.actionBin, "cache", cell.modelData.previewUrl || "", root.cacheDir]
                stdout: StdioCollector {
                  id: fetchStdout
                  waitForEnd: true
                }
                onExited: function(exitCode) {
                  if (exitCode !== 0) return
                  root.notePreview(cell.modelData.previewUrl, String(fetchStdout.text || "").trim())
                }
              }

              MouseArea {
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                acceptedButtons: Qt.LeftButton | Qt.MiddleButton | Qt.RightButton
                onContainsMouseChanged: if (containsMouse) {
                  root.cursorActive = true
                  root.selectedIndex = cell.index
                }
                onClicked: function(mouse) {
                  root.cursorActive = true
                  root.selectedIndex = cell.index
                  if (mouse.button === Qt.MiddleButton) root.runAction("copy-url")
                  else if (mouse.button === Qt.RightButton) root.runAction("open")
                  else root.runAction(root.enterVerb)
                }
              }
            }
          }

          // ------------------------------------------------------ empty states
          Column {
            anchors.centerIn: parent
            width: parent.width - Style.space(40)
            spacing: Style.space(8)
            visible: root.items.length === 0 && !root.loading

            Text {
              text: root.configured ? (root.errorText ? "󰀦" : "󰈉") : "󰌾"
              color: root.selectedText
              opacity: 0.8
              font.family: root.fontFamily
              font.pixelSize: Style.font.displayLarge
              horizontalAlignment: Text.AlignHCenter
              width: parent.width
            }

            Text {
              textFormat: Text.PlainText
              text: !root.configured
                ? "No " + root.providerLabel + " API key yet"
                : (root.errorText
                   ? root.errorText
                   : (root.filterText ? "No GIFs for “" + root.filterText + "”" : "No results"))
              color: root.foreground
              opacity: 0.85
              font.family: root.fontFamily
              font.pixelSize: Style.font.title
              horizontalAlignment: Text.AlignHCenter
              wrapMode: Text.WordWrap
              width: parent.width
            }

            Text {
              textFormat: Text.PlainText
              visible: root.configured && root.errorText.length > 0
              text: "Press Enter to try again"
              color: root.foreground
              opacity: 0.55
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              horizontalAlignment: Text.AlignHCenter
              width: parent.width
            }

            Text {
              textFormat: Text.PlainText
              visible: !root.configured
              text: "Searching needs a free API key — no GIF service offers "
                + "keyless search any more. Setup opens in a terminal and takes a minute."
              color: root.foreground
              opacity: 0.6
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              horizontalAlignment: Text.AlignHCenter
              wrapMode: Text.WordWrap
              width: parent.width
            }

            Item { width: 1; height: Style.space(4); visible: !root.configured }

            Row {
              anchors.horizontalCenter: parent.horizontalCenter
              spacing: Style.spacing.controlGap
              visible: !root.configured

              Repeater {
                model: root.setupProviders

                Button {
                  required property string modelData
                  text: "Set up " + Providers.providerLabel(root.catalogue, modelData)
                  bordered: true
                  foreground: root.foreground
                  accent: root.selectedText
                  fontFamily: root.fontFamily
                  onClicked: root.launchSetup(modelData)
                }
              }
            }

            Text {
              textFormat: Text.PlainText
              visible: !root.configured
              text: "Enter to choose in the terminal · key lands in " + root.shortConfigPath()
              color: root.foreground
              opacity: 0.45
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              horizontalAlignment: Text.AlignHCenter
              wrapMode: Text.WordWrap
              width: parent.width
            }
          }
        }

        // ------------------------------------------------------------ footer
        Item {
          width: parent.width
          height: root.footerHeight

          Text {
            id: titleLabel
            textFormat: Text.PlainText
            anchors.left: parent.left
            anchors.right: hintLabel.left
            anchors.rightMargin: Style.spacing.md
            anchors.verticalCenter: parent.verticalCenter
            text: {
              var item = root.currentItem()
              return item && item.title ? item.title : ""
            }
            color: root.foreground
            opacity: 0.55
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
          }

          Text {
            id: hintLabel
            textFormat: Text.PlainText
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            // While walking history the footer switches to that vocabulary,
            // which is also where Ctrl+Delete gets to announce itself without
            // crowding the default hints.
            text: !root.configured
              ? "^, setup"
              : (root.historyIndex >= 0
                 ? "^↑↓ history   ^Del forget all   ↵ " + Providers.enterActionLabel(root.config)
                 : "↵ " + Providers.enterActionLabel(root.config)
                   + "   ⇧↵ link   ^↵ paste   ⌥↵ GIF   ^↑ history   ^S save"
                   + (root.canSwapProvider ? "   ^P " + Providers.providerLabel(root.catalogue, root.swapTarget) : ""))
            color: root.foreground
            opacity: 0.45
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
        }
      }
    }
  }
}
