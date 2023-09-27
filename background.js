// Finding all of the messages that we need to check is complicated, for two
// reasons:
//
// 1 The messenger.messages.onNewMailReceived listener doesn't tell us about
//   messages in all folders. It seems, for example, to ignore "special"
//   folders like Sent Items on purpose (see
//   https://bugzilla.mozilla.org/show_bug.cgi?id=1848787 ).
//
// 2 Even in the folders that the listener is supposed to notify about, it
//   misses messages. See https://bugzilla.mozilla.org/show_bug.cgi?id=1850289
//   . I have two guesses about what's making it unreliable: offline -> online
//   transitions, and not all messages that arrive at the same time being
//   included in notifications. But honestly these are just guesses.
//
// To try to do the right thing given these constraints, we use these
// strategies:
//
// * When we get a NewMailReceived event, we trigger a scan that includes not
//   just the folders that match the scan regexp but also all the folder the
//   notification is for.
//
// * When we receive an online event, we wait a few seconds for the dust to
//   settle and then trigger a scan.
//
// * We scan folders at least every 60 seconds, including the two scan triggers
//   triggers mentioned above in that calculation (i.e., when we trigger an
//   out-of-cycle scan, the next timed scan happens 60 seconds after that scan
//   began).
//
// * When scanning folders, we repeat the scan consecutively until we do a full
//   scan without finding any new messages to process.

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

// True when scan is running, false otherwise.
// triggerScan is responsible for setting this to true; scan Folders is
// responsible for setting it to false when it's done scanning.
var scanRunning = false;
// We reset this when there's an out-of-cycle scan. triggerScan is responsible
// for maintaining the timer.
var scanTimer;
var scanDeadline;
// message IDs in the API are just numbers that increase monotonically. Each
// time the backend API needs to share a message with an extension it assigns a
// new number to that message. Therefore, to recognize and ignore messages
// we've already seen all we need to do is keep track of the maximum message ID
// we've seen.
var maxMessageId = 0;
// When we get a NewMailReceived event we add folders to this scanFoldersOnDeck.
// Before triggerScan starts a scan, it moves them to scanFoldersNow.
var scanFoldersOnDeck = [];
var scanFoldersNow = [];

async function getPref(name) {
  let fullName = PREF_PREFIX + name;
  return await browser.LegacyPrefs.getPref(fullName);
}

async function debug(...args) {
  let debug;
  try {
    debug = await getPref(debugPref);
  } catch (ex) {
    console.log("Failed to fetch debug pref, defaulting to true", ex);
    debug = true;
  }
  if (debug) {
    console.log("RCBF:", ...args);
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

  window.addEventListener("online", (event) => triggerScan(5000, "online"));
  messenger.messages.onNewMailReceived.addListener(checkNewMessages);
  scanTimer = setTimeout(() => triggerScan(undefined, "initial"), 1);
}

function triggerScan(timeout, reason) {
  // JavaScript is single-threaded, friends, and this function is synchronous,
  // so only one of them can be running at a time. Therefore we don't need to
  // worry about locking here, i.e., when this function is running, it's the
  // only thing that's thinking about starting a scan.
  debug("triggerScan()");
  let newScanDeadline = Date.now() + (timeout || 0);
  if (timeout && newScanDeadline > scanDeadline) {
    debug("triggerScan: next scan is too soon, ignoring trigger");
    return;
  }
  if (newScanDeadline > Date.now()) {
    delta = newScanDeadline - Date.now();
    debug(`triggerScan: scheduling scan for ${delta}ms in the future`);
    scanDeadline = newScanDeadline;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(triggerScan, delta);
    return;
  }
  if (scanRunning) {
    debug(
      "triggerScan: scan time arrived while scan still running, ",
      "postponing for 5s",
    );
    scanDeadline = Date.now() + 5000;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(triggerScan, 5000);
    return;
  }
  debug("triggerScan: scanning now and queuing next scan for 60s from now");
  scanDeadline = Date.now() + 60000;
  clearTimeout(scanTimer);
  scanTimer = setTimeout(triggerScan, 60000);
  scanFoldersNow = scanFoldersOnDeck;
  scanFoldersOnDeck = [];
  scanRunning = true;
  scanFolders(reason);
}

function folderIsInList(folder, list) {
  return list.some(
    (f) => f.accountId == folder.accountId && f.path == folder.path,
  );
}

async function scanFoldersBody(reason) {
  let scanRegexp = await getPref(scanPref);
  if (scanRegexp) {
    try {
      scanRegexp = new RegExp(scanRegexp);
    } catch (ex) {
      error(`Invalid scan regexp: "${scanRegexp}"`);
      return;
    }
  }
  let accounts = await messenger.accounts.list();
  let sawNewMessage = false;
  for (let account of accounts) {
    for (let folder of account.folders) {
      if (
        !(
          (scanRegexp && scanRegexp.test(folder.name)) ||
          folderIsInList(folder, scanFoldersNow)
        )
      )
        continue;
      let numScanned = 0;
      let numChanged = 0;
      debug(`Scanning for new messages in ${account.name}/${folder.name}`);
      let page = await messenger.messages.list(folder);
      while (true) {
        for (let message of page.messages) {
          if (message.id <= maxMessageId) continue;
          maxMessageId = message.id;
          numScanned += 1;
          sawNewMessage = true;
          if (await checkMessage(message, true)) {
            debug(`Changed message in ${reason} scan`);
            numChanged++;
          }
        }
        if (!page.id) break;
        page = await messenger.messages.continueList(page.id);
      }
      debug(
        `Scanned ${numScanned} messages in ${account.name}/` +
          `${folder.name}, changed ${numChanged}`,
      );
    }
  }
  return sawNewMessage;
}

async function scanFolders(reason) {
  debug(`scanFolders(${reason})`);
  let result;
  try {
    result = await scanFoldersBody(reason);
  } catch (ex) {
    error("Scan error:", ex);
  }
  scanRunning = false;
  // We should always see at least one new message when we were told to scan
  // specific folders, so if we didn't, should we try again?
  // On the one hand, what if the notification was sent prematurely (arguably a
  // TB bug) and they're not yet visible in the folder index?
  // On the other hand, what if the messages were somehow removed in between
  // when we got the notification and when we scanned, so if we keep trying
  // we'll be in an infinite loop of scanning over and over until the user
  // receives a message that we detect and scan?
  // The infinite loop sounds bad, and we always have a scan scheduled for at
  // most 60 seconds in the future, so I'm going to err on the side of not
  // scanning again.

  // Having said all that, we do want to keep scanning until there are no new
  // messages for us to look at.
  if (result) triggerScan(undefined, "rescan after found new messages");
}

async function checkNewMessages(folder, messages) {
  folderString = `${folder.accountId}/${folder.name}`;
  if (folderIsInList(folder, scanFoldersOnDeck)) {
    debug(
      `checkNewMessages: Folder ${folderString} already in queue, `,
      "not queuing again",
    );
  } else {
    debug(`checkNewMessages: Adding folder ${folderString} to queue`);
    scanFoldersOnDeck.push(folder);
  }

  triggerScan(undefined, "NewMailReceived");
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
      `Switching content policy for message ${message.id} `,
      `("${message.subject}") from "${currentPolicy}" to "${requestedPolicy}"`,
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
        `Testing ${prefName} regexp "${regexp}" against folder name `,
        `"${msgHdr.folder.name}"`,
      );
      if (regexpObj.test(msgHdr.folder.name)) {
        await debug(
          `${prefName} regexp "${regexp}" matched folder name `,
          `"${msgHdr.folder.name}"`,
        );
        return true;
      }
      await debug(
        `${prefName} regexp "${regexp}" did not match folder name `,
        `"${msgHdr.folder.name}"`,
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
