import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Ui
import "UsageLogic.js" as Logic

// The scrolling body of the AI Usage panel: one collapsible section per
// provider, all in one list. Panel.qml mounts it inside the bar popup; the
// dev harness mounts it in a plain window.
//
// The rows (LimitRow, Meter, DayRow, ModelRow) and every type size, color
// and spacing are carried over from Omarchy's built-in Agents panel
// (plugins/agents/Panel.qml, MIT, by Omarchy), so an expanded section reads
// exactly like one of its tabs.
Item {
  id: root

  // Main.qml, or anything with the same providers / expandedOverrides /
  // setExpanded / newestUpdate / refreshing surface.
  property var usage: null
  property color foreground: Color.foreground
  property color urgent: Color.urgent
  property string fontFamily: Style.font.family
  property double nowMs: Date.now()
  // Stand-in mark for a provider that ships no SVG: the bar glyph.
  property string fallbackGlyph: "󱚣"

  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property color surface: Color.popups.background
  readonly property color track: Style.selectedFillFor(foreground, Color.accent)
  readonly property bool lightSurface: colorLuminance(surface) >= 0.5

  readonly property var providers: usage ? usage.providers : []
  readonly property var overrides: usage ? usage.expandedOverrides : ({})
  readonly property string defaultExpanded: Logic.defaultExpandedId(providers)

  // Keyboard cursor over the section headers. It follows the provider, not
  // the slot, so a record that lands while the panel is open does not move
  // it underneath you.
  property bool cursorActive: false
  property string cursorId: ""
  readonly property int cursorIndex: {
    for (var i = 0; i < providers.length; i++) if (providers[i].providerId === cursorId) return i
    return 0
  }

  readonly property real contentImplicitHeight: column.implicitHeight
  readonly property alias flick: panelFlick

  implicitHeight: column.implicitHeight

  function alpha(c, a) { return Qt.rgba(c.r, c.g, c.b, a) }

  function colorChannelLuminance(value) {
    var channel = Number(value)
    if (!isFinite(channel)) return 0
    return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)
  }

  function colorLuminance(color) {
    return 0.2126 * colorChannelLuminance(color.r)
      + 0.7152 * colorChannelLuminance(color.g)
      + 0.0722 * colorChannelLuminance(color.b)
  }

  function expanded(id) { return Logic.isExpanded(id, overrides, defaultExpanded) }

  function setExpanded(id, value) {
    if (usage) usage.setExpanded(id, value)
  }

  function toggle(id) { setExpanded(id, !expanded(id)) }

  function sectionItem(index) { return sectionRepeater.itemAt(index) }

  function resetView() {
    cursorActive = false
    cursorId = providers.length > 0 ? providers[0].providerId : ""
    panelFlick.contentY = 0
  }

  // ------------------------------------------------------------- keyboard

  function maxScroll() { return Math.max(0, panelFlick.contentHeight - panelFlick.height) }

  function scrollTo(y) { panelFlick.contentY = Logic.clamp(y, 0, maxScroll()) }

  function ensureVisible(item) {
    if (!item) return
    var margin = Style.space(6)
    var top = item.mapToItem(column, 0, 0).y
    var bottom = top + item.height
    if (top < panelFlick.contentY + margin) scrollTo(top - margin)
    else if (bottom > panelFlick.contentY + panelFlick.height - margin) scrollTo(bottom + margin - panelFlick.height)
  }

  // j/k walk the headers. An open section taller than the viewport is paged
  // through first, so nothing in it is skipped on the way to the next one.
  function moveCursor(dy) {
    if (providers.length === 0) return
    if (!cursorActive) {
      cursorActive = true
      if (cursorId === "") cursorId = providers[0].providerId
      ensureVisible(sectionItem(cursorIndex) ? sectionItem(cursorIndex).header : null)
      return
    }
    var step = Style.space(56)
    var current = sectionItem(cursorIndex)
    if (current && expanded(providers[cursorIndex].providerId)) {
      var top = current.mapToItem(column, 0, 0).y
      var bottom = top + current.height
      if (dy > 0 && bottom > panelFlick.contentY + panelFlick.height + 1 && panelFlick.contentY < maxScroll()) {
        scrollTo(panelFlick.contentY + step)
        return
      }
      if (dy < 0 && top < panelFlick.contentY - 1) {
        scrollTo(panelFlick.contentY - step)
        return
      }
    }
    var next = Logic.clamp(cursorIndex + dy, 0, providers.length - 1)
    if (next === cursorIndex) {
      scrollTo(panelFlick.contentY + dy * step)
      return
    }
    cursorId = providers[next].providerId
    var section = sectionItem(next)
    if (section) ensureVisible(section.header)
  }

  function toggleCursor() {
    if (providers.length === 0) return
    cursorActive = true
    var id = providers[cursorIndex].providerId
    if (cursorId === "") cursorId = id
    toggle(id)
    Qt.callLater(function() {
      var section = sectionItem(cursorIndex)
      if (section) ensureVisible(section.header)
    })
  }

  function setCursorExpanded(value) {
    if (providers.length === 0) return
    cursorActive = true
    var id = providers[cursorIndex].providerId
    if (cursorId === "") cursorId = id
    setExpanded(id, value)
  }

  function footerText() {
    if (usage && usage.refreshing) return "Refreshing…"
    var at = usage ? String(usage.newestUpdate || "") : ""
    if (at === "") return ""
    var ms = new Date(at).getTime()
    if (!isFinite(ms)) return ""
    var age = root.nowMs - ms
    return age < 60000 ? "Updated just now" : "Updated " + Logic.compactDuration(age) + " ago"
  }

  // ---------------------------------------------------------------- list

  Flickable {
    id: panelFlick
    anchors.fill: parent
    contentWidth: width
    contentHeight: column.implicitHeight
    clip: true
    boundsBehavior: Flickable.StopAtBounds
    flickableDirection: Flickable.VerticalFlick
    interactive: contentHeight > height
    ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

    Column {
      id: column
      width: panelFlick.width
      spacing: Style.space(8)

      Text {
        visible: root.providers.length === 0
        width: parent.width
        topPadding: Style.space(24)
        bottomPadding: Style.space(24)
        text: "No AI usage records found.\nRun piquota omarchy, or use an agent once."
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        horizontalAlignment: Text.AlignHCenter
        wrapMode: Text.WordWrap
      }

      Repeater {
        id: sectionRepeater
        model: root.providers

        ProviderSection {
          required property var modelData
          required property int index
          width: column.width
          provider: modelData
          sectionIndex: index
          isLast: index === root.providers.length - 1
        }
      }

      Text {
        textFormat: Text.PlainText
        visible: text !== ""
        width: parent.width
        topPadding: Style.space(2)
        text: root.footerText()
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        horizontalAlignment: Text.AlignHCenter
        elide: Text.ElideRight
      }
    }
  }

  // ------------------------------------------------------------ section

  component ProviderSection: Column {
    id: section
    property var provider: null
    property int sectionIndex: 0
    property bool isLast: false
    property alias header: headerSurface

    readonly property bool open: !!provider && root.expanded(provider.providerId)
    readonly property var head: Logic.headline(provider)
    readonly property var limitList: provider && (!provider.accounts || provider.accounts.length === 0)
      ? Logic.limitWindows(provider.limits) : []
    readonly property var accountList: Logic.accountRows(provider)
    readonly property var balance: provider ? provider.balance : null
    readonly property bool balanceAlarming: Logic.balanceAlarming(balance)
    readonly property var models: Logic.modelRows(provider)
    readonly property bool hasDays: Logic.hasDays(provider)

    spacing: Style.space(12)

    // ---------- Header: mark · name · plan · headline ----------
    CursorSurface {
      id: headerSurface
      width: parent.width
      hasCursor: root.cursorActive && root.cursorIndex === section.sectionIndex
      foreground: root.foreground
      implicitHeight: headerContent.implicitHeight + Style.spacing.lg * 2

      MouseArea {
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
        onEntered: {
          root.cursorActive = true
          root.cursorId = section.provider.providerId
        }
        onClicked: {
          root.cursorId = section.provider.providerId
          root.toggle(section.provider.providerId)
        }
      }

      Item {
        id: headerContent
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        anchors.leftMargin: Style.space(8)
        anchors.rightMargin: Style.space(8)
        implicitHeight: Math.max(mark.height, labels.implicitHeight, trailing.implicitHeight)

        Mark {
          id: mark
          providerId: section.provider ? section.provider.providerId : ""
          size: Style.font.display
          anchors.left: parent.left
          anchors.verticalCenter: parent.verticalCenter
        }

        Column {
          id: labels
          anchors.left: mark.right
          anchors.leftMargin: Style.space(14)
          anchors.right: trailing.left
          anchors.rightMargin: Style.space(10)
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(2)

          Row {
            width: parent.width
            spacing: Style.space(8)

            Text {
              id: nameText
              textFormat: Text.PlainText
              text: section.provider ? section.provider.providerName : ""
              width: Math.min(implicitWidth, parent.width - (chip.visible ? chip.width + parent.spacing : 0))
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.title
              font.bold: true
              elide: Text.ElideRight
              anchors.verticalCenter: parent.verticalCenter
            }

            BorderSurface {
              id: chip
              readonly property string label: Logic.statusChip(section.provider)
              visible: label !== ""
              width: chipText.implicitWidth + Style.space(10)
              height: chipText.implicitHeight + Style.space(2)
              anchors.verticalCenter: parent.verticalCenter
              color: root.alpha(root.urgent, 0.10)
              borderSpec: Border.flat(root.alpha(root.urgent, 0.35), 1)
              radius: Style.cornerRadius

              Text {
                id: chipText
                textFormat: Text.PlainText
                anchors.centerIn: parent
                text: chip.label
                color: root.urgent
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                font.bold: true
              }
            }
          }

          Text {
            textFormat: Text.PlainText
            width: parent.width
            text: Logic.headerMeta(section.provider).toUpperCase()
            visible: text !== ""
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            font.bold: true
            font.letterSpacing: 1.2
            elide: Text.ElideRight
          }
        }

        Row {
          id: trailing
          anchors.right: parent.right
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(10)

          Column {
            visible: !!section.head
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(2)

            Text {
              textFormat: Text.PlainText
              anchors.right: parent.right
              text: section.head ? Math.round(section.head.percent * 100) + "%" : ""
              color: section.head && section.head.percent >= 0.9 ? root.urgent : root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.title
              font.bold: true
            }

            Text {
              textFormat: Text.PlainText
              anchors.right: parent.right
              text: {
                if (!section.head) return ""
                var ms = Logic.resetMs(section.head, root.nowMs)
                return section.head.title + (ms > 0 ? " · " + Logic.compactDuration(ms) : "")
              }
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }
          }

          Text {
            textFormat: Text.PlainText
            anchors.verticalCenter: parent.verticalCenter
            text: section.open ? "󰅀" : "󰅂"
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.icon
          }
        }
      }
    }

    // A folded section still shows how full its headline window is.
    Meter {
      visible: !section.open && !!section.head
      width: parent.width
      value: section.head ? section.head.percent : -1
      alarming: !!section.head && section.head.percent >= 0.9
    }

    // ---------- Body: the built-in tab, section by section ----------
    Column {
      id: body
      visible: section.open
      width: parent.width
      spacing: Style.space(14)

      // Status
      BorderSurface {
        visible: !!section.provider && section.provider.usageStatusText !== "" && section.provider.authHelpText !== ""
        width: parent.width
        implicitHeight: statusText.implicitHeight + Style.spacing.xl * 2
        color: root.alpha(root.urgent, 0.10)
        borderSpec: Border.flat(root.alpha(root.urgent, 0.35), 1)
        radius: Style.cornerRadius

        Text {
          id: statusText
          textFormat: Text.PlainText
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.verticalCenter: parent.verticalCenter
          anchors.leftMargin: Style.space(12)
          anchors.rightMargin: Style.space(12)
          text: section.provider
            ? (section.provider.ready ? section.provider.usageStatusText + ": " : "") + section.provider.authHelpText
            : ""
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
        }
      }

      // Balance
      Column {
        visible: !!section.balance
        width: parent.width
        spacing: Style.space(10)

        readonly property real ratio: section.balance && section.balance.funded > 0
          ? Logic.clamp(section.balance.remaining / section.balance.funded, 0, 1)
          : -1

        PanelSectionHeader {
          width: parent.width
          text: "BALANCE"
          foreground: root.foreground
          fontFamily: root.fontFamily
        }

        Item {
          width: parent.width
          implicitHeight: Math.max(balanceLabel.implicitHeight, balanceValue.implicitHeight)

          Text {
            id: balanceLabel
            text: "Prepaid credits"
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
          }

          Text {
            id: balanceValue
            textFormat: Text.PlainText
            text: section.balance ? Logic.formatMoney(section.balance.remaining, section.balance.currency) : ""
            color: section.balanceAlarming ? root.urgent : root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
          }
        }

        Meter {
          visible: parent.ratio >= 0
          width: parent.width
          value: parent.ratio
          alarming: section.balanceAlarming
        }

        Text {
          textFormat: Text.PlainText
          visible: text !== ""
          width: parent.width
          text: Logic.balanceDetailText(section.balance)
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }
      }

      // Limits (single account)
      Column {
        id: limitsSection
        visible: section.limitList.length > 0
        width: parent.width
        spacing: Style.space(10)

        PanelSectionHeader {
          text: "LIMITS"
          foreground: root.foreground
          fontFamily: root.fontFamily
        }

        Repeater {
          model: section.limitList

          LimitRow {
            required property var modelData
            width: limitsSection.width
            window: modelData
          }
        }
      }

      // Accounts (multi-account): one row per account, every window
      Column {
        id: accountsSection
        visible: section.accountList.length > 0
        width: parent.width
        spacing: Style.space(10)

        // The label column fits the widest label ("#1-api", "#14"), so no label
        // runs into the window columns; a pathological one is capped and elided.
        TextMetrics {
          id: labelMetrics
          text: Logic.longestId(section.accountList)
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
          font.bold: true
        }
        readonly property real labelWidth: Math.min(
          Math.max(Style.space(30), Math.ceil(labelMetrics.advanceWidth) + Style.space(2)),
          Math.round(width * 0.35))

        PanelSectionHeader {
          text: "ACCOUNTS"
          foreground: root.foreground
          fontFamily: root.fontFamily
        }

        Repeater {
          model: section.accountList

          AccountRow {
            required property var modelData
            width: accountsSection.width
            labelWidth: accountsSection.labelWidth
            account: modelData
          }
        }
      }

      // Tokens by day
      Column {
        id: usageSection
        visible: section.hasDays
        width: parent.width
        spacing: Style.spacing.md

        readonly property var days: section.provider ? Logic.recentDayRows(section.provider) : []
        readonly property real peak: Math.max(1, Logic.weekPeak(section.provider))

        PanelSectionHeader {
          width: parent.width
          text: "TOKENS BY DAY"
          foreground: root.foreground
          fontFamily: root.fontFamily
        }

        Repeater {
          model: usageSection.days

          DayRow {
            required property var modelData
            width: usageSection.width
            day: modelData
            provider: section.provider
            ratio: Number(modelData.messageCount || 0) / usageSection.peak
            today: String(modelData.date || "") === Logic.todayDate(root.nowMs)
          }
        }
      }

      // Tokens by model
      Column {
        id: modelSection
        visible: section.models.length > 0
        width: parent.width
        spacing: Style.spacing.md

        PanelSectionHeader {
          width: parent.width
          text: "TOKENS BY MODEL"
          foreground: root.foreground
          fontFamily: root.fontFamily
        }

        Repeater {
          model: section.models

          ModelRow {
            required property var modelData
            width: modelSection.width
            row: modelData
            share: modelData.total / Math.max(1, section.models[0].total)
          }
        }
      }

      Item { width: 1; height: Style.space(2) }
    }

    PanelSeparator {
      visible: !section.isLast
      foreground: root.foreground
    }
  }

  // Provider mark: assets/<id>.svg, then the family without the pi- prefix,
  // each with a -light twin first on light surfaces; the bar glyph otherwise.
  component Mark: Item {
    id: markItem
    property string providerId: ""
    property real size: Style.font.display
    property var candidates: Logic.iconCandidates(providerId, root.lightSurface)
    // Restart the fallback walk only when the URLs change: re-pointing source
    // at a URL whose load already failed emits no statusChanged.
    property string candidatesKey: candidates.join("\n")
    property int candidateIndex: 0
    onCandidatesKeyChanged: candidateIndex = 0

    width: size
    height: size

    Image {
      id: markImage
      anchors.fill: parent
      source: markItem.candidateIndex < markItem.candidates.length ? Qt.resolvedUrl(markItem.candidates[markItem.candidateIndex]) : ""
      sourceSize.width: markItem.size * 2
      sourceSize.height: markItem.size * 2
      fillMode: Image.PreserveAspectFit
      onStatusChanged: if (status === Image.Error && markItem.candidateIndex < markItem.candidates.length)
        Qt.callLater(function() { markItem.candidateIndex++ })
    }

    Text {
      textFormat: Text.PlainText
      anchors.centerIn: parent
      visible: markImage.status !== Image.Ready
      text: root.fallbackGlyph
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: markItem.size
    }
  }

  // A limit window: label and percentage, meter, and reset countdown.
  component LimitRow: Column {
    id: limitRow
    property var window: null

    readonly property bool alarming: window && window.percent >= 0.9

    spacing: Style.space(6)

    Item {
      width: parent.width
      implicitHeight: Math.max(limitLabel.implicitHeight, limitValue.implicitHeight)

      Text {
        id: limitLabel
        textFormat: Text.PlainText
        text: limitRow.window ? limitRow.window.title : ""
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        elide: Text.ElideRight
        anchors.left: parent.left
        anchors.right: limitValue.left
        anchors.rightMargin: Style.spacing.sm
        anchors.verticalCenter: parent.verticalCenter
      }

      Text {
        id: limitValue
        textFormat: Text.PlainText
        text: limitRow.window && limitRow.window.percent >= 0
          ? Math.round(limitRow.window.percent * 100) + "%"
          : "—"
        color: limitRow.alarming ? root.urgent : root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
      }
    }

    Meter {
      width: parent.width
      value: limitRow.window ? limitRow.window.percent : -1
      alarming: limitRow.alarming
    }

    Text {
      textFormat: Text.PlainText
      width: parent.width
      text: {
        var remainingMs = Logic.resetMs(limitRow.window, root.nowMs)
        return remainingMs > 0 ? "Resets in " + Logic.formatDuration(remainingMs) : ""
      }
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }
  }

  // One account of a multi-account provider: its slot, then every window as
  // a column of tag, percentage, reset and a mini meter, aligned across rows
  // like a table. A failed account is dimmed and says why.
  component AccountRow: Item {
    id: accountRow
    property var account: null
    property real labelWidth: Style.space(30)

    readonly property var windows: account ? account.windows : []
    readonly property bool ok: !!account && account.ok
    readonly property real columnGap: Style.space(12)

    implicitHeight: Math.max(slotText.implicitHeight, ok && windows.length > 0 ? windowColumns.implicitHeight : statusLine.implicitHeight)
    opacity: ok ? 1 : 0.55

    Text {
      id: slotText
      textFormat: Text.PlainText
      text: accountRow.account ? accountRow.account.id : ""
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      font.bold: true
      width: accountRow.labelWidth
      elide: Text.ElideRight
      anchors.left: parent.left
      anchors.top: parent.top
    }

    Row {
      id: windowColumns
      visible: accountRow.ok && accountRow.windows.length > 0
      anchors.left: slotText.right
      anchors.leftMargin: Style.space(6)
      anchors.right: parent.right
      anchors.top: parent.top
      spacing: accountRow.columnGap

      readonly property real cellWidth: accountRow.windows.length > 0
        ? (width - spacing * (accountRow.windows.length - 1)) / accountRow.windows.length
        : 0

      Repeater {
        model: accountRow.windows

        Column {
          id: cell
          required property var modelData
          readonly property bool alarming: modelData.percent >= 0.9
          width: windowColumns.cellWidth
          spacing: Style.space(4)

          Item {
            width: parent.width
            implicitHeight: cellPercent.implicitHeight

            Text {
              id: cellTag
              textFormat: Text.PlainText
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
              width: Math.min(implicitWidth, Math.max(0, cellReset.x - cellPercent.implicitWidth - Style.space(8)))
              elide: Text.ElideRight
              text: Logic.windowTag(cell.modelData.title)
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }

            Text {
              id: cellPercent
              textFormat: Text.PlainText
              anchors.left: cellTag.right
              anchors.leftMargin: Style.space(4)
              anchors.verticalCenter: parent.verticalCenter
              text: Math.round(cell.modelData.percent * 100) + "%"
              color: cell.alarming ? root.urgent : root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
            }

            Text {
              id: cellReset
              textFormat: Text.PlainText
              anchors.right: parent.right
              text: {
                var ms = Logic.resetMs(cell.modelData, root.nowMs)
                return ms > 0 ? Logic.compactDuration(ms) : ""
              }
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }
          }

          Meter {
            width: parent.width
            thickness: Math.max(Style.space(3), Math.round(Style.spacing.controlHeight * 0.1))
            value: cell.modelData.percent
            alarming: cell.alarming
          }
        }
      }
    }

    Text {
      id: statusLine
      visible: !accountRow.ok || accountRow.windows.length === 0
      textFormat: Text.PlainText
      anchors.left: slotText.right
      anchors.leftMargin: Style.space(6)
      anchors.right: parent.right
      anchors.verticalCenter: slotText.verticalCenter
      text: accountRow.account && accountRow.account.status !== "" ? accountRow.account.status : "No usage windows"
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      elide: Text.ElideRight
    }
  }

  // Rounded track showing the percentage of the allowance used.
  component Meter: Item {
    id: meter
    property real value: -1
    property bool alarming: false
    property real thickness: Math.max(Style.space(4), Math.round(Style.spacing.controlHeight * 0.14))

    implicitHeight: thickness

    Rectangle {
      id: meterTrack
      anchors.fill: parent
      radius: height / 2
      color: root.track
    }

    Rectangle {
      anchors.left: meterTrack.left
      anchors.verticalCenter: meterTrack.verticalCenter
      height: meterTrack.height
      radius: meterTrack.radius
      width: meterTrack.width * Logic.clamp(meter.value, 0, 1)
      color: meter.alarming ? root.urgent : root.foreground

      Behavior on width {
        NumberAnimation { duration: 160; easing.type: Easing.OutCubic }
      }
    }
  }

  // One row per day: label, bar, tokens. Today is picked out in full
  // foreground so the week reads as a run-up to right now.
  component DayRow: Item {
    id: dayRow
    property var day: null
    property var provider: null
    property real ratio: 0
    property bool today: false

    implicitHeight: Math.max(dayLabel.implicitHeight, dayValue.implicitHeight) + Style.spacing.sm

    Text {
      id: dayLabel
      textFormat: Text.PlainText
      text: Logic.dayLabel(dayRow.day ? dayRow.day.date : "", dayRow.today)
      color: dayRow.today ? root.foreground : root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      font.bold: dayRow.today
      anchors.left: parent.left
      anchors.verticalCenter: parent.verticalCenter
      width: Style.space(52)
    }

    Rectangle {
      anchors.left: dayLabel.right
      anchors.right: dayValue.left
      anchors.leftMargin: Style.space(8)
      anchors.rightMargin: Style.space(10)
      anchors.verticalCenter: parent.verticalCenter
      height: Math.max(Style.space(4), Math.round(Style.spacing.controlHeight * 0.14))
      radius: height / 2
      color: root.track

      Rectangle {
        anchors.left: parent.left
        anchors.verticalCenter: parent.verticalCenter
        height: parent.height
        radius: parent.radius
        width: parent.width * Logic.clamp(dayRow.ratio, 0, 1)
        color: dayRow.today ? root.foreground : root.alpha(root.foreground, 0.55)

        Behavior on width {
          NumberAnimation { duration: 160; easing.type: Easing.OutCubic }
        }
      }
    }

    Text {
      id: dayValue
      textFormat: Text.PlainText
      text: Logic.formatTokenCount(dayRow.day ? Number(dayRow.day.messageCount || 0) : 0)
      color: dayRow.today ? root.foreground : root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      font.bold: true
      horizontalAlignment: Text.AlignRight
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      width: Style.space(52)
    }

    MouseArea {
      id: dayHover
      anchors.fill: parent
      hoverEnabled: true
      acceptedButtons: Qt.NoButton
    }

    PanelToolTip {
      visible: dayHover.containsMouse
      text: Logic.dayTooltip(dayRow.day, dayRow.today, dayRow.provider)
      fontFamily: root.fontFamily
    }
  }

  // Model rows read as a table: the share bar fills the row behind the label.
  component ModelRow: Item {
    id: modelRow
    property var row: null
    property real share: 0

    implicitHeight: modelName.implicitHeight + Style.spacing.lg

    Rectangle {
      anchors.fill: parent
      radius: Style.cornerRadius
      color: root.alpha(root.foreground, 0.05)
    }

    Rectangle {
      anchors.left: parent.left
      anchors.top: parent.top
      anchors.bottom: parent.bottom
      width: parent.width * Logic.clamp(modelRow.share, 0, 1)
      radius: Style.cornerRadius
      color: root.alpha(root.foreground, 0.14)

      Behavior on width {
        NumberAnimation { duration: 160; easing.type: Easing.OutCubic }
      }
    }

    Text {
      id: modelName
      textFormat: Text.PlainText
      text: modelRow.row ? modelRow.row.name : ""
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      elide: Text.ElideRight
      anchors.left: parent.left
      anchors.leftMargin: Style.space(8)
      anchors.right: modelTokens.left
      anchors.rightMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
    }

    Text {
      id: modelTokens
      textFormat: Text.PlainText
      text: modelRow.row ? Logic.formatTokenCount(modelRow.row.total) : ""
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      font.bold: true
      anchors.right: parent.right
      anchors.rightMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
    }

    MouseArea {
      id: modelHover
      anchors.fill: parent
      hoverEnabled: true
      acceptedButtons: Qt.NoButton
    }

    PanelToolTip {
      visible: modelHover.containsMouse
      text: Logic.modelTooltip(modelRow.row)
      fontFamily: root.fontFamily
    }
  }
}
