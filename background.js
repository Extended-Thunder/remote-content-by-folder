const PREF_PREFIX = "extensions.remote-content-by-folder.";

const debugPref = "debug";
const allowPref = "allow_regexp";
const blockPref = "block_regexp";
const scanPref = "scan_regexp";
const blockFirstPref = "block_first";

const PREF_DEFAULTS = {
  [debugPref]: false,
  [allowPref]: "",
  [blockPref]: "",
  [scanPref]: "",
  [blockFirstPref]: false,
};

var scanTimer;
var scannedIds = [];

async function getPref(name) {
  let fullName = PREF_PREFIX + name;
  return await browser.LegacyPrefs.getPref(fullName);
}

async function debug(msg) {
  let debug;
  try {
    debug = await getPref(debugPref);
  } catch (ex) {
    console.log("Failed to fetch debug pref, defaulting to true", ex);
    debug = true;
  }
  if (debug) {
    console.log("RCBF:", msg);
  }
}

function error(...args) {
  console.error("RCBF:", ...args);
}

async function init() {
  // TODO: Migrate LegacyPrefs to local storage.
  let prefs = {};
  for (let [name, value] of Object.entries(PREF_DEFAULTS)) {
    await browser.LegacyPrefs.setDefaultPref(`${PREF_PREFIX}${name}`, value);
  }

  messenger.messages.onNewMailReceived.addListener(checkNewMessages);
  await scanFolders();
}

async function scanFolders() {
  let scanRegexp = await getPref(scanPref);
  if (!scanRegexp) {
    return;
  }
  let regexp;
  try {
    regexp = new RegExp(scanRegexp);
  } catch (ex) {
    error(`Invalid scan regexp: "${scanRegexp}"`);
    return;
  }

  let accounts = await messenger.accounts.list();
  for (let account of accounts) {
    for (let folder of account.folders) {
      if (regexp.test(folder.name)) {
        let numScanned = 0;
        let numChanged = 0;
        debug(`Scanning for new messages in ${account.name}/${folder.name}`);
        let page = await messenger.messages.list(folder);
        while (true) {
          for (let message of page.messages) {
            if (!scannedIds) {
              // If it's null then the checkNewMessages listener was called
              // while we were scanning.
              debug("Aborting scan");
              break;
            }
            if (scannedIds.includes(message.id)) {
              continue;
            }
            scannedIds.push(message.id);
            numScanned += 1;
            let changed = await checkMessage(message, true);
            if (changed) {
              numChanged += 1;
            }
          }
          if (!page.id) {
            break;
          }
          page = await messenger.messages.continueList(page.id);
        }
        if (
          !scanTimer || // first time
          numScanned
        ) {
          debug(
            `Scanned ${numScanned} messages in ${account.name}/` +
              `${folder.name}, changed ${numChanged}`,
          );
        }
      }
    }
  }
  // There is some sort of timing issue here. Even though I'm adding the
  // `scanFolders` call after adding the event listener, I'm not getting
  // notified about all newly received messages. In attempt to work around
  // this, I'm going to scan folders every five seconds until the first time my
  // listener is called. I _hope_ that once my listener is called the first
  // time it will be called reliably from that point forward, but who knows. I
  // guess we'll find out.
  if (scannedIds) {
    // If it's null then the checkNewMessages listener was called while we
    // were scanning.
    scanTimer = setTimeout(scanFolders, 5000);
  }
}

async function checkNewMessages(folder, messages) {
  if (scanTimer) {
    debug("Clearing scan timer");
    clearTimeout(scanTimer);
    scanTimer = null;
    scannedIds = null;
  }
  for (let message of messages.messages) {
    await checkMessage(message);
  }
}

async function checkMessage(message, scanning) {
  let currentPolicy = await browser.RemoteContent.getContentPolicy(message.id);
  if (currentPolicy != "None") {
    if (!scanning) {
      await debug(
        `Content policy for message ${message.id} ("${message.subject}") is ` +
          `set to "${currentPolicy}", not modifying`,
      );
    }
    return false;
  }

  // Get newPolicy from regex match.
  let requestedPolicy = await getPolicyFromRegExMatch(message);
  if (requestedPolicy && currentPolicy != requestedPolicy) {
    await debug(
      `Switching content policy for message ${message.id} ("${message.subject}") from "${currentPolicy}" to "${requestedPolicy}"`,
    );
    await browser.RemoteContent.setContentPolicy(message.id, requestedPolicy);
    return requestedPolicy;
  }
  return false;
}

async function getPolicyFromRegExMatch(message) {
  let blockFirst = await getPref(blockFirstPref);
  if (blockFirst) {
    if (await checkRegexp(message, blockPref)) {
      return "Block";
    }
  }

  if (await checkRegexp(message, allowPref)) {
    return "Allow";
  }

  if (!blockFirst) {
    if (await checkRegexp(message, blockPref)) {
      return "Block";
    }
  }

  return undefined;
}

async function checkRegexp(msgHdr, prefName) {
  let regexp = await getPref(prefName);
  if (regexp != "") {
    try {
      let regexpObj = new RegExp(regexp);
      await debug(
        `Testing ${prefName} regexp "${regexp}" against folder name "${msgHdr.folder.name}"`,
      );
      if (regexpObj.test(msgHdr.folder.name)) {
        await debug(
          `${prefName} regexp "${regexp}" matched folder name "${msgHdr.folder.name}"`,
        );
        return true;
      }
      await debug(
        `${prefName} regexp "${regexp}" did not match folder name "${msgHdr.folder.name}"`,
      );
      return false;
    } catch (ex) {
      error(`Invalid regexp: "${regexp}"`);
      return false;
    }
  }

  await debug(`${prefName} is empty, not testing`);
  return false;
}

init();
