const PREF_PREFIX = "extensions.remote-content-by-folder.";
const MAPPINGS = [
  ["rcbf-allow-box", "allow_regexp", "string"],
  ["rcbf-block-box", "block_regexp", "string"],
  ["rcbf-scan-box", "scan_regexp", "string"],
  ["rcbf-block-first-pref", "block_first", "bool"],
  ["rcbf-debug", "debug", "bool"],
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

function init() {
  let btn_save = document.getElementById("btn_save");
  let btn_reset = document.getElementById("btn_reset");
  let btn_cancel = document.getElementById("btn_cancel");
  btn_save.addEventListener("click", saveSettings);
  btn_reset.addEventListener("click", loadSettings);
  btn_cancel.addEventListener("click", cancelSettings);
  loadSettings();
}

window.addEventListener("load", init, false);
window.addEventListener(
  "DOMContentLoaded",
  () => {
    i18n.updateDocument();
  },
  { once: true },
);
