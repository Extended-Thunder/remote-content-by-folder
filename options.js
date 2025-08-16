const PREF_PREFIX = "extensions.remote-content-by-folder.";
const MAPPINGS = [
  ["rcbf-allow-box", "allow_regexp", "string"],
  ["rcbf-block-box", "block_regexp", "string"],
  ["rcbf-scan-box", "scan_regexp", "string"],
  ["rcbf-block-first-pref", "block_first", "bool"],
  ["rcbf-debug", "debug", "bool"],
  ["rcbf-debug-level", "debug_level", "string"],
];

async function loadSettings() {
  for (let mapping of MAPPINGS) {
    var elt_id = mapping[0];
    var elt = document.getElementById(elt_id);
    var pref_name = mapping[1];
    var pref_type = mapping[2];
    switch (pref_type) {
      case "bool":
        elt.checked = await browser.LegacyPrefs.getPref(
          `${PREF_PREFIX}${pref_name}`,
        );
        break;
      case "string":
        elt.value = await browser.LegacyPrefs.getPref(
          `${PREF_PREFIX}${pref_name}`,
        );
        break;
      default:
        throw new Error("Unrecognized pref type: " + pref_type);
    }
  }

  elt = document.getElementById("rcbf-debug");
  elt.addEventListener("change", updateSettings);
  updateSettings();
}

function updateSettings() {
  var checkbox = document.getElementById("rcbf-debug");
  var level = document.getElementById("rcbf-debug-level");
  level.disabled = !checkbox.checked;
}

async function saveSettings() {
  for (let mapping of MAPPINGS) {
    var elt_id = mapping[0];
    var elt = document.getElementById(elt_id);
    var pref_name = mapping[1];
    var pref_type = mapping[2];
    switch (pref_type) {
      case "bool":
        await browser.LegacyPrefs.setPref(
          `${PREF_PREFIX}${pref_name}`,
          elt.checked,
        );
        break;
      case "string":
        await browser.LegacyPrefs.setPref(
          `${PREF_PREFIX}${pref_name}`,
          elt.value,
        );
        break;
      default:
        throw new Error("Unrecognized pref type: " + pref_type);
    }
  }
  window.close();
}

async function cancelSettings() {
  window.close();
}

async function init() {
  let btn_save = document.getElementById("btn_save");
  let btn_reset = document.getElementById("btn_reset");
  let btn_cancel = document.getElementById("btn_cancel");
  btn_save.addEventListener("click", saveSettings);
  btn_reset.addEventListener("click", loadSettings);
  btn_cancel.addEventListener("click", cancelSettings);
  loadSettings();
  await loadEventLog();
}

var userScrolling = false;

async function getEventLog(el) {
  if (!el) {
    let { eventLog } = await messenger.storage.local.get({ eventLog: {} });
    el = eventLog;
  }
  let keys = Object.keys(el).sort();
  let built = "";
  for (let key of keys) built += el[key];
  return built;
}

async function loadEventLog() {
  let eventLog = await getEventLog();
  let elt = document.getElementById("eventLog");
  elt.value = eventLog;
  elt.setSelectionRange(eventLog.length, eventLog.length);
  // When the page opens, we want the event log to be scrolling automatically
  // as new content is added to the bottom of it. However, once the user
  // scrolls up slightly, we want to stop the automatic scrolling until they
  // scroll back down to the bottom.
  // When they are all the way at the bottom, the formula
  // elt.scrollHeight - (elt.scrollTop + elt.clientHeight) _should_ equal 0,
  // but it's not always exactly there, so we are leaving a small error
  // margin to produce the desired behavior.
  elt.addEventListener("scroll", (event) => {
    let elt = event.target;
    userScrolling = elt.scrollHeight - (elt.scrollTop + elt.clientHeight) > 10;
  });
  document
    .getElementById("btn_clearEventLog")
    .addEventListener("click", clearEventLog);
  messenger.storage.local.onChanged.addListener(updateEventLog);
}

async function clearEventLog() {
  await messenger.storage.local.set({ eventLog: {} });
}

async function updateEventLog(changes, area) {
  var change = changes["eventLog"];
  if (!change) return;
  let eventLog = await getEventLog(change.newValue);
  let elt = document.getElementById("eventLog");
  let saveUserScrolling = userScrolling;
  elt.value = eventLog;
  if (!saveUserScrolling) scrollEventLogToEnd();
}

function scrollEventLogToEnd() {
  let elt = document.getElementById("eventLog");
  elt.setSelectionRange(elt.value.length, elt.value.length);
  if (elt.scrollHeight - (elt.scrollTop + elt.clientHeight) >= 10)
    setTimeout(scrollEventLogToEnd, 100);
  else userScrolling = false;
}

window.addEventListener("load", init, false);
window.addEventListener(
  "DOMContentLoaded",
  () => {
    i18n.updateDocument();
  },
  { once: true },
);
