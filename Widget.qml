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

  function open() {
    if (root.bar && root.bar.shell && typeof root.bar.shell.summon === "function")
      root.bar.shell.summon(root.moduleName, "{}")
    else if (root.bar && typeof root.bar.run === "function")
      root.bar.run("omarchy-shell shell summon " + root.moduleName + " '{}'")
    else
      Quickshell.execDetached(["omarchy-shell", "shell", "summon", root.moduleName, "{}"])
  }

  function close() {
    if (root.bar && root.bar.shell && typeof root.bar.shell.hide === "function")
      root.bar.shell.hide(root.moduleName)
    else if (root.bar && typeof root.bar.run === "function")
      root.bar.run("omarchy-shell shell hide " + root.moduleName)
    else
      Quickshell.execDetached(["omarchy-shell", "shell", "hide", root.moduleName])
  }

  function toggle() {
    if (root.bar && root.bar.shell && typeof root.bar.shell.toggle === "function")
      root.bar.shell.toggle(root.moduleName, "{}")
    else if (root.bar && typeof root.bar.run === "function")
      root.bar.run("omarchy-shell shell toggle " + root.moduleName + " '{}'")
    else
      Quickshell.execDetached(["omarchy-shell", "shell", "toggle", root.moduleName, "{}"])
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
