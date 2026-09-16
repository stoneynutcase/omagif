import QtQuick
import Quickshell
import Quickshell.Io
import qs.Ui

// Bar button for the GIF picker. Prefers the in-process shell handle so the
// click costs nothing; the IPC and CLI paths are fallbacks for when the widget
// is mounted without a live bar reference.
BarWidget {
  id: root
  moduleName: "stoneynutcase.omagif"

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  readonly property bool opened: root.bar && root.bar.shell && typeof root.bar.shell.isPluginOpen === "function"
    ? root.bar.shell.isPluginOpen(root.moduleName)
    : false

  // The three fallbacks below start Omarchy's own CLI, and only when neither
  // the in-process handle nor the bar's runner is available. It cannot be
  // handed a cleared environment — `omarchy-shell` needs OMARCHY_PATH and the
  // session's runtime directory — so the one thing said here is that the
  // system copy wins over anything planted earlier on the session's PATH.
  readonly property var omarchyEnv: ({
    "PATH": "/usr/local/bin:/usr/bin:/bin" + (Quickshell.env("PATH") ? ":" + Quickshell.env("PATH") : "")
  })

  function open() {
    if (root.bar && root.bar.shell && typeof root.bar.shell.summon === "function")
      root.bar.shell.summon(root.moduleName, "{}")
    else if (root.bar && typeof root.bar.run === "function")
      root.bar.run("omarchy-shell shell summon " + root.moduleName + " '{}'")
    else
      Quickshell.execDetached({
        command: ["omarchy-shell", "shell", "summon", root.moduleName, "{}"],
        environment: root.omarchyEnv
      })
  }

  function close() {
    if (root.bar && root.bar.shell && typeof root.bar.shell.hide === "function")
      root.bar.shell.hide(root.moduleName)
    else if (root.bar && typeof root.bar.run === "function")
      root.bar.run("omarchy-shell shell hide " + root.moduleName)
    else
      Quickshell.execDetached({
        command: ["omarchy-shell", "shell", "hide", root.moduleName],
        environment: root.omarchyEnv
      })
  }

  function toggle() {
    if (root.bar && root.bar.shell && typeof root.bar.shell.toggle === "function")
      root.bar.shell.toggle(root.moduleName, "{}")
    else if (root.bar && typeof root.bar.run === "function")
      root.bar.run("omarchy-shell shell toggle " + root.moduleName + " '{}'")
    else
      Quickshell.execDetached({
        command: ["omarchy-shell", "shell", "toggle", root.moduleName, "{}"],
        environment: root.omarchyEnv
      })
  }

  IpcHandler {
    target: root.moduleName

    function open(): void { root.open() }
    function close(): void { root.close() }
    function toggle(): void { root.toggle() }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "󰋹"
    tooltipText: "Search GIFs"
    active: root.opened
    onPressed: function(b) {
      if (b === Qt.LeftButton) root.toggle()
    }
  }
}
