// Pure logic for the AI Usage panel.
//
// No QML imports and no wall clock: Panel.qml and UsageContent.qml load this
// file as a JS module (import "UsageLogic.js" as Logic), and the node tests
// evaluate it in a sandbox. Every function that needs "now" takes it as an
// argument.
//
// The window, model-name and token formatting helpers are carried over from
// Omarchy's built-in Agents plugin (plugins/agents, MIT, by Omarchy) so the
// two panels read a record the same way.

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

// A record's lists arrive as JS arrays from JSON.parse, but once they pass
// through a Repeater's modelData they are QML sequences, which
// Array.isArray rejects. Anything with a numeric length is a list here.
function isList(value) {
  return !!value && typeof value === "object" && typeof value.length === "number"
}

function toArray(value) {
  if (!isList(value)) return []
  var out = []
  for (var i = 0; i < value.length; i++) out.push(value[i])
  return out
}

function numberValue(value) {
  var n = Number(value || 0)
  return isFinite(n) ? Math.round(n) : 0
}

// ------------------------------------------------------------------ windows

// Claude spells its windows out ("Session (5-hour)"), Codex abbreviates them
// ("5h window", "30m window"). Both have to land on the same record.
function windowIsLong(text) {
  return text.indexOf("week") >= 0 || text.indexOf("7-day") >= 0 || text.indexOf("seven") >= 0
    || text.indexOf("month") >= 0 || text.indexOf("30-day") >= 0
}

function windowSpanMs(label) {
  var text = String(label || "").toLowerCase()
  if (text.indexOf("month") >= 0 || text.indexOf("30-day") >= 0) return 30 * 24 * 3600 * 1000
  if (windowIsLong(text)) return 7 * 24 * 3600 * 1000
  var hours = text.match(/(\d+)\s*-?\s*h(?:our)?\b/)
  if (hours) return Number(hours[1]) * 3600 * 1000
  var minutes = text.match(/(\d+)\s*-?\s*m(?:in(?:ute)?s?)?\b/)
  if (minutes) return Number(minutes[1]) * 60 * 1000
  return 0
}

function windowTitle(label) {
  var text = String(label || "").toLowerCase()
  if (text.indexOf("month") >= 0) return "Monthly"
  if (windowIsLong(text)) return "Weekly"
  if (text.indexOf("session") >= 0 || windowSpanMs(label) > 0) return "Session"
  var plain = String(label || "").replace(/\s*\(.*\)\s*/, "").trim()
  return plain === "" ? "Limit" : plain
}

// A collector that already knows which window a limit belongs to says so in
// `title`, and that beats reading it back out of the label.
function limitWindow(label, percent, resetAt, title) {
  return {
    title: String(title || "") !== "" ? String(title) : windowTitle(label),
    percent: Number(percent),
    resetAt: String(resetAt || "")
  }
}

// Negative percentages are placeholders (an error record keeps its tab with
// one), never drawn.
function limitWindows(list) {
  var out = []
  list = toArray(list)
  for (var i = 0; i < list.length; i++) {
    var entry = list[i] || {}
    var percent = Number(entry.percent)
    if (entry.percent !== null && entry.percent !== undefined && entry.percent !== "" && percent >= 0) {
      percent = clamp(percent, 0, 1)
      out.push(limitWindow(entry.label, percent, entry.resetsAt, entry.title))
    }
  }
  return out
}

function resetOrder(w) {
  if (!w || w.resetAt === "") return Infinity
  var ms = new Date(w.resetAt).getTime()
  return isFinite(ms) ? ms : Infinity
}

// The window that decides how much room is left: the fullest one, and on a
// tie the one that resets first.
function bindingWindow(windows) {
  var best = null
  for (var i = 0; i < (windows || []).length; i++) {
    var w = windows[i]
    if (!best || w.percent > best.percent
        || (w.percent === best.percent && resetOrder(w) < resetOrder(best))) best = w
  }
  return best
}

// The short words /usage uses for an account's windows.
function windowTag(title) {
  var text = String(title || "")
  if (text === "Session") return "session"
  if (text === "Weekly") return "week"
  if (text === "Monthly") return "month"
  return text.toLowerCase()
}

function resetMs(w, nowMs) {
  if (!w || !w.resetAt) return -1
  var ms = new Date(w.resetAt).getTime()
  return isFinite(ms) ? ms - nowMs : -1
}

// "Resets in 2d 4h": the built-in panel's countdown.
function formatDuration(ms) {
  if (!(ms > 0)) return "now"
  var minutes = Math.floor(ms / 60000)
  var hours = Math.floor(minutes / 60)
  var days = Math.floor(hours / 24)
  if (days > 0) return days + "d " + (hours % 24) + "h"
  if (hours > 0) return hours + "h " + (minutes % 60) + "m"
  return Math.max(1, minutes) + "m"
}

// One unit, for the dense rows: 10m, 4h, 19d — the same reading as /usage.
function compactDuration(ms) {
  if (!(ms > 0)) return "now"
  var minutes = Math.floor(ms / 60000)
  if (minutes < 60) return Math.max(1, minutes) + "m"
  var hours = Math.floor(minutes / 60)
  if (hours < 24) return hours + "h"
  return Math.floor(hours / 24) + "d"
}

// ----------------------------------------------------------------- accounts

// One row per account of a multi-account record, every window kept.
function accountRows(p) {
  var list = p && isList(p.accounts) ? p.accounts : []
  var rows = []
  for (var i = 0; i < list.length; i++) {
    var entry = list[i] || {}
    var windows = limitWindows(entry.limits)
    rows.push({
      id: String(entry.id || ("#" + (i + 1))),
      ok: entry.ok === true,
      status: String(entry.status || ""),
      windows: windows,
      binding: bindingWindow(windows)
    })
  }
  return rows
}

function failedAccountCount(p) {
  var rows = accountRows(p)
  var failed = 0
  for (var i = 0; i < rows.length; i++) if (!rows[i].ok) failed++
  return failed
}

// What the section header and the bar alarm read.
//
// A single account is bound by its fullest window. Several accounts of one
// family are used one after another (pi rotates to the next slot when one is
// exhausted), so what stops the next prompt is the account with the most
// room left: the healthy account whose own fullest window is the emptiest.
// That is the "lowest" figure /usage prints for the family.
function headline(p) {
  if (!p) return null
  var rows = accountRows(p)
  if (rows.length > 0) {
    var best = null
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i]
      if (!row.ok || !row.binding) continue
      if (!best || row.binding.percent < best.binding.percent
          || (row.binding.percent === best.binding.percent && resetOrder(row.binding) < resetOrder(best.binding)))
        best = row
    }
    if (best) return {
      title: best.id + " · " + best.binding.title,
      percent: best.binding.percent,
      resetAt: best.binding.resetAt,
      accountId: best.id
    }
    // Every account failed: fall through to the flattened limits, which then
    // only hold the placeholder and yield nothing.
  }
  return bindingWindow(limitWindows(p.limits))
}

function urgency(p) {
  var h = headline(p)
  if (h) return h.percent
  if (p && p.balance && p.balance.funded > 0)
    return 1 - clamp(p.balance.remaining / p.balance.funded, 0, 1)
  return -1
}

// ---------------------------------------------------------------- expansion

// With nothing chosen yet, the section that is closest to stopping you opens
// and the rest stay folded: their headers already carry the headline, so the
// panel answers "am I about to run out?" without a keystroke. Ties go to the
// window that resets first; with no limits anywhere the first section opens.
function defaultExpandedId(providers) {
  var best = null
  var bestUrgency = -Infinity
  var bestReset = Infinity
  for (var i = 0; i < (providers || []).length; i++) {
    var p = providers[i]
    var u = urgency(p)
    var h = headline(p)
    var r = h ? resetOrder(h) : Infinity
    if (best === null || u > bestUrgency || (u === bestUrgency && r < bestReset)) {
      best = p
      bestUrgency = u
      bestReset = r
    }
  }
  return best ? String(best.providerId) : ""
}

// An explicit choice sticks; an untouched section follows the default.
function isExpanded(id, overrides, defaultId) {
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, id)) return overrides[id] === true
  return id === defaultId
}

function withExpanded(overrides, id, expanded) {
  var next = {}
  for (var key in (overrides || {})) next[key] = overrides[key]
  next[id] = expanded === true
  return next
}

function parseUiState(text) {
  try {
    var parsed = JSON.parse(String(text || ""))
    var expanded = parsed && parsed.expanded && typeof parsed.expanded === "object" ? parsed.expanded : {}
    var clean = {}
    for (var key in expanded) if (typeof expanded[key] === "boolean") clean[key] = expanded[key]
    return { expanded: clean }
  } catch (e) {
    return { expanded: {} }
  }
}

function serializeUiState(state) {
  return JSON.stringify({ schemaVersion: 1, expanded: (state && state.expanded) || {} }, null, 2) + "\n"
}

// ---------------------------------------------------------------- providers

function balanceValue(raw) {
  if (!raw || typeof raw !== "object") return null
  var remaining = Number(raw.remaining)
  var funded = Number(raw.funded)
  if (!isFinite(remaining) || remaining < 0) return null
  return {
    remaining: remaining,
    funded: isFinite(funded) && funded > 0 ? funded : 0,
    spent: Math.max(0, Number(raw.spent) || 0),
    currency: String(raw.currency || "USD"),
    estimated: raw.estimated === true
  }
}

// The record, normalized the way the built-in Main.qml does (minus the
// cross-device merge), plus the accounts list.
function displayProvider(record) {
  record = record || {}
  return {
    providerId: String(record.id),
    providerName: String(record.name || record.id),
    ready: record.ready === true,
    usageStatusText: String(record.usageStatusText || ""),
    authHelpText: String(record.authHelpText || ""),
    limits: isList(record.limits) ? record.limits : [],
    accounts: isList(record.accounts) ? record.accounts : [],
    tierLabel: String(record.tierLabel || ""),
    balance: balanceValue(record.balance),
    todayPrompts: numberValue(record.todayPrompts),
    todaySessions: numberValue(record.todaySessions),
    todayTotalTokens: numberValue(record.todayTotalTokens),
    recentDays: isList(record.recentDays) ? record.recentDays : [],
    totalPrompts: numberValue(record.totalPrompts),
    totalSessions: numberValue(record.totalSessions),
    activeDays: numberValue(record.activeDays),
    modelUsage: record.modelUsage && typeof record.modelUsage === "object" ? record.modelUsage : {},
    hasLocalStats: record.hasLocalStats !== false,
    hasPromptStats: record.hasPromptStats !== false
  }
}

// The built-in rule: a provider earns a section by having produced numbers.
function providerHasData(p) {
  return numberValue(p.totalPrompts) > 0 || numberValue(p.totalSessions) > 0
    || numberValue(p.activeDays) > 0 || numberValue(p.todayPrompts) > 0
    || numberValue(p.todaySessions) > 0 || (p.limits && p.limits.length > 0)
    || (p.accounts && p.accounts.length > 0) || !!p.balance
}

function providerEnabled(settings, id) {
  if (!settings || !settings.providers || !settings.providers[id]) return true
  return settings.providers[id].enabled !== false
}

function pluginVisible(providers) {
  return isList(providers) && providers.length > 0
}

function uiStateDirectory(stateHome, override) {
  var path = String(override || "")
  return path !== "" ? path : String(stateHome || "") + "/omarchy/settings"
}

function queueUpdateKind(pending, requested) {
  if (requested === "force" || pending === "") return requested
  return pending
}

// Whether this plugin may run Omarchy's collectors at all. "On" always, "Auto"
// only while the built-in Agents widget is off the bar (so keeping both never
// doubles the work), "Off" never. Anything unrecognized reads as Auto, the
// manifest default, so a missing or mistyped setting cannot switch the
// collectors on.
function collectorsWanted(setting, builtinOnBar) {
  var mode = String(setting === null || setting === undefined ? "Auto" : setting).trim().toLowerCase()
  if (mode === "off") return false
  if (mode === "on") return true
  return builtinOnBar !== true
}

// A collector that could not reach its limits endpoint writes retryAdvised
// into its record. A retry is a collector run like any other, so it inherits
// the same switch: with the setting Off, or Auto while the built-in widget is
// on the bar, no id comes back and nothing runs.
function advisedRetryIds(records, settings, collectors) {
  if (!collectors) return []
  var ids = []
  records = toArray(records)
  for (var i = 0; i < records.length; i++) {
    var record = records[i]
    var id = record && String(record.id || "")
    if (id && record.retryAdvised === true && providerEnabled(settings, id)) ids.push(id)
  }
  return ids
}

function recordTime(record) {
  var ms = Date.parse(String(record && record.updatedAt || ""))
  return isFinite(ms) ? ms : -Infinity
}

// One id is one section. A stale file, or a fixture dropped next to a live
// record, can claim an id that already exists; the newest updatedAt wins, so
// the panel never draws a provider twice and the second copy cannot share the
// first one's expansion state.
function newestRecords(records) {
  var chosen = {}
  var order = []
  for (var i = 0; i < (records || []).length; i++) {
    var record = records[i]
    if (!record || !record.id) continue
    var id = String(record.id)
    if (!Object.prototype.hasOwnProperty.call(chosen, id)) {
      chosen[id] = record
      order.push(id)
      continue
    }
    if (recordTime(record) >= recordTime(chosen[id])) chosen[id] = record
  }
  var out = []
  for (var j = 0; j < order.length; j++) out.push(chosen[order[j]])
  return out
}

// Records sorted by id, the built-in's order, enabled and non-empty only.
function visibleProviders(records, settings) {
  var list = []
  var unique = newestRecords(records)
  for (var i = 0; i < unique.length; i++) {
    var record = unique[i]
    if (!providerEnabled(settings, String(record.id))) continue
    var p = displayProvider(record)
    if (providerHasData(p)) list.push(p)
  }
  list.sort(function(a, b) { return a.providerId < b.providerId ? -1 : (a.providerId > b.providerId ? 1 : 0) })
  return list
}

// The plan line under the name. A provider that cannot report says why
// instead, the same substitution the built-in hero makes.
function headerMeta(p) {
  if (!p) return ""
  if (!p.ready && p.usageStatusText !== "") return p.usageStatusText
  var tier = String(p.tierLabel || "")
  if (tier === "") return "Subscription"
  return tier.charAt(0).toUpperCase() + tier.slice(1)
}

// A short chip on the header when something needs attention.
function statusChip(p) {
  if (!p) return ""
  if (!p.ready) return p.usageStatusText !== "" ? "Unavailable" : ""
  var failed = failedAccountCount(p)
  if (failed > 0) return failed + " down"
  return ""
}

// Marks resolve by convention: assets/<family>.svg for a pi- record
// (pi-claude -> claude.svg), then assets/<id>.svg, each with a -light twin
// tried first on light surfaces.
// Marks that need a dark twin on light surfaces; every other shipped mark
// reads on both. Listing them keeps the lookup from logging a failed load
// for a -light file that was never shipped.
var LIGHT_TWINS = { codex: true }

function iconCandidates(providerId, lightSurface) {
  var id = String(providerId || "")
  // The family first: this plugin ships family marks, so a pi- record finds
  // its mark on the first try instead of logging a failed load.
  var names = id.indexOf("pi-") === 0 && id.length > 3 ? [id.slice(3), id] : [id]
  var out = []
  for (var i = 0; i < names.length; i++) {
    if (lightSurface && LIGHT_TWINS[names[i]] === true) out.push("assets/" + names[i] + "-light.svg")
    out.push("assets/" + names[i] + ".svg")
  }
  return out
}

// -------------------------------------------------------------- local stats

// A corrupt or hand-written record can carry a count no provider will ever
// report (1e299, Infinity). Those must not reach the panel as "1e+299B" or
// "InfinityB": a non-finite count renders as an em dash and the unit is capped
// at billions.
var MAX_TOKEN_COUNT = 999.9e9

function formatTokenCount(n) {
  if (n === undefined || n === null) return "0"
  var value = Number(n)
  if (!isFinite(value)) return "—"
  n = Math.min(value, MAX_TOKEN_COUNT)
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B"
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M"
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K"
  return String(n)
}

function modelWordCase(word) {
  if (word === "gpt") return "GPT"
  if (word === "deepseek") return "DeepSeek"
  return word.charAt(0).toUpperCase() + word.slice(1)
}

// `claude-opus-4-8` -> "Opus 4.8", `gpt-5.6-sol` -> "GPT 5.6 Sol".
function friendlyModelName(id) {
  if (!id) return "Unknown"
  var name = String(id).replace(/^claude-/, "").replace(/-\d{8}$/, "")
  var parts = name.split("-")
  var words = []
  var version = []
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i]
    if (part === "") continue
    if (/^\d/.test(part)) {
      version.push(part)
      continue
    }
    if (version.length > 0) {
      words.push(version.join("."))
      version = []
    }
    words.push(modelWordCase(part))
  }
  if (version.length > 0) words.push(version.join("."))
  return words.length > 0 ? words.join(" ") : "Unknown"
}

function recentDayRows(p) {
  var days = p && isList(p.recentDays) ? p.recentDays : []
  var rows = []
  for (var i = 0; i < days.length; i++) {
    var day = days[i]
    if (day && typeof day === "object") rows.push(day)
  }
  return rows
}

function hasDays(p) {
  return !!p && p.hasLocalStats !== false && recentDayRows(p).length > 0
}

function weekPeak(p) {
  var days = p ? (p.recentDays || []) : []
  var peak = 0
  for (var i = 0; i < days.length; i++) {
    var day = days[i]
    peak = Math.max(peak, Number(day && day.messageCount || 0))
  }
  return peak
}

// The heaviest four models, as the built-in shows them.
function modelRows(p) {
  var usageByModel = p && p.hasLocalStats !== false ? (p.modelUsage || {}) : {}
  var rows = []
  for (var id in usageByModel) {
    var bucket = usageByModel[id] || {}
    var input = Number(bucket.inputTokens || 0)
    var output = Number(bucket.outputTokens || 0)
    var cacheRead = Number(bucket.cacheReadInputTokens || 0)
    var cacheWrite = Number(bucket.cacheCreationInputTokens || 0)
    rows.push({
      name: friendlyModelName(id),
      total: input + output + cacheRead + cacheWrite,
      input: input,
      output: output,
      cacheRead: cacheRead,
      cacheWrite: cacheWrite
    })
  }
  rows.sort(function(a, b) { return b.total - a.total })
  return rows.slice(0, 4)
}

function modelTooltip(row) {
  if (!row) return ""
  return "In " + formatTokenCount(row.input)
    + " · out " + formatTokenCount(row.output)
    + " · cache read " + formatTokenCount(row.cacheRead)
    + " · cache write " + formatTokenCount(row.cacheWrite)
}

function todayDate(nowMs) {
  var now = new Date(nowMs)
  return now.getFullYear()
    + "-" + String(now.getMonth() + 1).padStart(2, "0")
    + "-" + String(now.getDate()).padStart(2, "0")
}

function dayName(date) {
  var parsed = new Date(String(date || "") + "T00:00:00")
  if (isNaN(parsed.getTime())) return String(date || "")
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][parsed.getDay()]
}

function dayLabel(date, today) {
  return today ? "Today" : dayName(date)
}

function dayTooltip(day, today, p) {
  if (!day) return ""
  var parsed = new Date(String(day.date) + "T00:00:00")
  var label = isNaN(parsed.getTime())
    ? String(day.date)
    : dayName(day.date) + " " + (parsed.getMonth() + 1) + "/" + parsed.getDate()
  var text = label + " · " + formatTokenCount(Number(day.messageCount || 0)) + " tokens"
  if (today && p && p.hasPromptStats !== false)
    text += " · " + Number(p.todayPrompts || 0) + " prompts · " + Number(p.todaySessions || 0) + " sessions"
  return text
}

// ------------------------------------------------------------------ balance

function currencyPrefix(currency) {
  var code = String(currency || "USD").toUpperCase()
  if (code === "USD") return "$"
  if (code === "EUR") return "€"
  if (code === "GBP") return "£"
  return code + " "
}

var MAX_MONEY_AMOUNT = 999999.99

function formatMoney(value, currency) {
  var amount = Number(value)
  // A non-finite amount is unknown, not zero: "$0.00" would read as an empty balance.
  if (!isFinite(amount)) return "—"
  amount = Math.max(-MAX_MONEY_AMOUNT, Math.min(amount, MAX_MONEY_AMOUNT))
  return currencyPrefix(currency) + amount.toFixed(2)
}

function balanceDetailText(b) {
  if (!b || !(b.funded > 0)) return ""
  var text = formatMoney(b.spent, b.currency) + " spent of " + formatMoney(b.funded, b.currency) + " funded"
  if (b.estimated) text += " · estimated"
  return text
}

function balanceAlarming(b) {
  return !!b && b.funded > 0 && b.remaining / b.funded <= 0.1
}
