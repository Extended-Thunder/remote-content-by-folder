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
//   mentioned above in that calculation (i.e., when we trigger an out-of-cycle
//   scan, the next timed scan happens 60 seconds after that scan began).

// This class stores a compact representation of an arbitrarily long sequence
// of integers. The more gaps there are in the sequence, the more memory it
// will take up, but this isn't a big problem for our use case because the
// message IDs returned by Thunderbird to the extension have a lot of
// contiguous ranges in them.
//
// The internal representation of the sequence is an array of objects in
// ascending order which represent non-overlapping ranges by specifying their
// start and end numbers.
//
// You call isMember() to find out if a number is in the set, or add() to add
// a number to the set. For efficiency, add() assumes that the number you
// specified isn't already in the set, and behavior is undefined and may be
// wrong if you violate that, so don't.
//
// Since Thunderbird frequently returns a bunch of message IDs to us in
// monotonically increasing order, there's a performance optimization here
// wherein we keep track of the last range we operated on so we can find it
// quickly if it's relevant to the next number we need to do something with.
//
// I'm sure someone already wrote something like this in some JavaScript
// library somewhere, but I don't want to have to include an entire library
// just for one little bit of it, and besides, it took me less than an hour
// to write and it was an interesting little puzzle.
class SequenceSet {
  constructor() {
    this.ranges = [];
    this.lastRange = null;
  }

  isMember(num) {
    if (
      this.lastRange &&
      this.lastRange.start <= num &&
      this.lastRange.end >= num
    )
      return true;

    for (let range of this.ranges) {
      if (range.start > num) return false;
      if (range.end >= num) {
        this.lastRange = range;
        return true;
      }
    }
    return false;
  }

  // Do not call this with numbers that are already in the set.
  add(num) {
    if (this.lastRange && this.lastRange.end == num - 1) {
      this.lastRange.end = num;
      let lastIndex = this.ranges.indexOf(this.lastRange);
      if (lastIndex == this.ranges.length - 1) return;
      if (this.ranges[lastIndex + 1].start == num + 1) {
        this.lastRange.end = this.ranges[lastIndex + 1].end;
        this.ranges.splice(lastIndex + 1, 1);
      }
      return;
    }
    for (let i = 0; i < this.ranges.length; i++) {
      if (this.ranges[i].start > num) {
        if (this.ranges[i].start == num + 1) {
          this.ranges[i].start = num;
          this.lastRange = this.ranges[i];
          return;
        }
        let range = {
          start: num,
          end: num,
        };
        this.ranges.splice(i, 0, range);
        this.lastRange = range;
        return;
      }
      if (this.ranges[i].end == num - 1) {
        this.lastRange = this.ranges[i];
        this.add(num);
        return;
      }
    }
    let range = {
      start: num,
      end: num,
    };
    this.ranges.splice(this.ranges.length, 0, range);
    this.lastRange = range;
  }

  dump() {
    let msg = "";
    for (let range of this.ranges) {
      msg += `${range.start}:${range.end} `;
    }
    return msg.trim();
  }

  // Generate 100 random numbers between 1 and 100. Give each of them a 75%
  // chance of going into the sequence. When done confirm that only the members
  // we expect to be in the sequence are there.
  test() {
    let inseq = [];
    for (let i = 0; i < 100; i++) {
      let num = Math.floor(Math.random() * 100);
      if (this.isMember(num)) continue;
      if (inseq.indexOf(num) > -1)
        console.log("isMember is wrong", num, this.dump());
      if (Math.random() <= 0.75) {
        this.add(num);
        if (!this.isMember(num))
          console.log(`just added ${num} but it didn't work`, this.dump());
        inseq.push(num);
      }
    }
    for (let i = 0; i < 100; i++) {
      if (inseq.indexOf(i) == -1 && this.isMember(i))
        console.log(`${i} should not be in sequence but isMember says it is`);
    }
    console.log(inseq.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    console.log(this.dump());
  }
}

const PREF_PREFIX = "extensions.remote-content-by-folder.";

const debugPref = "debug";
const debugLevelPref = "debug_level";
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
  [debugLevelPref]: "1",
};

// True when scan is running, false otherwise.
// triggerScan is responsible for setting this to true; scan Folders is
// responsible for setting it to false when it's done scanning.
var scanRunning = false;
// We reset this when there's an out-of-cycle scan. triggerScan is responsible
// for maintaining the timer.
var scanTimer;
var scanDeadline;
// When we get a NewMailReceived event we add folders to this scanFoldersOnDeck.
// Before triggerScan starts a scan, it moves them to scanFoldersNow.
var scanFoldersOnDeck = [];
var scanFoldersNow = [];
var scannedFolders = {};
var seen = new SequenceSet();

async function* getMessages(list) {
  let page = await list;
  for (let message of page.messages) {
    yield message;
  }

  while (page.id) {
    page = await messenger.messages.continueList(page.id);
    for (let message of page.messages) {
      yield message;
    }
  }
}

async function folderPath(account, folder) {
  if (!account) {
    account = await messenger.accounts.get(folder.accountId);
  }
  return `${account.name}${folder.path}`;
}

async function describeMessage(message) {
  if (!(message.headerMessageId || message.subject || message.author)) {
    var newMessage, msg;
    try {
      newMessage = await messenger.messages.get(message.id);
    } catch (ex) {
      msg =
        `Internal Thunderbird error: message ${message.id} returned by ` +
        `API to extension is missing data and attempt to refetch it ` +
        `failed with ${ex}`;
      registerAnomaly(msg);
      return `${message.id}`;
    }
    message = newMessage;
    if (!(message.headerMessageId || message.subject || message.author)) {
      msg =
        `Internal Thunderbird error: message ${message.id} returned by ` +
        `API to extension is missing data and data is still missing after ` +
        `refetching message.`;
      registerAnomaly(msg);
      return `${message.id}`;
    }
    msg =
      `Internal Thunderbird error: message ${message.id} returned by ` +
      `API to extension was initially missing data, but data appeared ` +
      `after refetching: headerMessageId=${message.headerMessageId} ` +
      `subject=${message.subject} author=${message.author}`;
    registerAnomaly(msg);
  }
  return (
    `${message.id} ${message.headerMessageId} "${message.subject}" ` +
    `${message.author}`
  );
}

async function* describeMessages(messages) {
  for (let message of messages.slice(0, 10)) {
    yield describeMessage(message);
  }
  for (let message of messages.slice(10)) {
    yield `${message.id}`;
  }
}

async function getPref(name) {
  let fullName = PREF_PREFIX + name;
  return await browser.LegacyPrefs.getPref(fullName);
}

async function debug(msgLevel, ...args) {
  let debug;
  try {
    debug = await getPref(debugPref);
  } catch (ex) {
    console.log("Failed to fetch debug pref, defaulting to true", ex);
    debug = true;
  }
  if (debug) {
    var maxLevel = Number(await getPref(debugLevelPref, 1));
    if (msgLevel <= maxLevel) {
      console.log("RCBF:", ...args);
      return true;
    }
  }
  return false;
}

function info(...args) {
  console.log("RCBF:", ...args);
}

function error(...args) {
  console.error("RCBF:", ...args);
}

var pendingEvents = [];
var flushingEvents;

async function flushEvents() {
  try {
    let { eventLog } = await messenger.storage.local.get({ eventLog: {} });

    while (pendingEvents.length) {
      let event = pendingEvents.shift();
      let now = event[0];
      let args = event[1];

      let timestamp = now.toISOString();

      let msg = timestamp + ":";
      for (let piece of args) {
        msg += ` ${piece}`;
      }
      msg += "\n";

      let date = timestamp.replace(/T.*/, "");
      if (eventLog[date]) eventLog[date] += msg;
      else eventLog[date] = msg;
      if (eventLog.length > 2) {
        // Keep today and yesterday
        let keys = Object.keys(eventLog);
        let old = keys.sort().slice(0, keys.length - 2);
        for (let date of old) delete eventLog[date];
      }
    }

    await messenger.storage.local.set({ eventLog: eventLog });
  } catch (ex) {
    flushingEvents = undefined;
    throw ex;
  }
  flushingEvents = undefined;
}

async function event(...args) {
  pendingEvents.push([new Date(), args]);
  if (!flushingEvents) flushingEvents = flushEvents();
  await flushingEvents;
  if (!pendingEvents || flushingEvents) return;
  flushingEvents = flushEvents();
  await flushingEvents;
}

async function enterEvent(func, ...args) {
  // They passed in the function, not its name.
  if (typeof func == "function") func = func.name;
  let msg = ["Entering", func];
  if (args.length) {
    msg.push("with arguments:", ...args);
  }
  await event(...msg);
}

async function returnEvent(func, value, ...args) {
  // They passed in the function, not its name.
  if (typeof func == "function") func = func.name;
  let msg = ["Returning from", func];
  if (value !== undefined) {
    msg.push("with value", value);
  }
  if (args.length) {
    msg.push("additional info:", ...args);
  }
  await event(...msg);
}

async function infoEvent(func, ...args) {
  // They passed in the function, not its name.
  if (typeof func == "function") func = func.name;
  await event(`info from ${func}:`, ...args);
  info(...args);
}

async function errorEvent(func, ...args) {
  // They passed in the function, not its name.
  if (typeof func == "function") func = func.name;
  await event(`ERROR from ${func}:`, ...args);
  error(...args);
}

async function registerAnomaly(msg) {
  await messenger.storage.local.set({ lastAnomaly: new Date() });
  messenger.notifications.create("rcbfAnomaly", {
    type: "basic",
    title: "Remote Content By Folder anomaly",
    message: msg,
  });
}

async function init() {
  await enterEvent("init");
  // TODO: Migrate LegacyPrefs to local storage.
  let prefs = {};
  for (let [name, value] of Object.entries(PREF_DEFAULTS)) {
    await browser.LegacyPrefs.setDefaultPref(`${PREF_PREFIX}${name}`, value);
  }

  window.addEventListener("online", (event) => triggerScan("online", 5000));
  messenger.messages.onNewMailReceived.addListener(checkNewMessages, true);
  messenger.notifications.onClicked.addListener(async (notificationId) => {
    if (notificationId != "rcbfAnomaly") return;
    let { lastAnomaly } = await messenger.storage.local.get({
      lastAnomaly: null,
    });
    if (lastAnomaly)
      await messenger.storage.local.set({ scrollTo: lastAnomaly });
    messenger.runtime.openOptionsPage();
  });
  scanTimer = setTimeout(() => triggerScan("initial"), 1);
  await returnEvent("init");
}

async function triggerScan(reason, timeout) {
  // JavaScript is single-threaded, friends, and this function is synchronous,
  // so only one of them can be running at a time. Therefore we don't need to
  // worry about locking here, i.e., when this function is running, it's the
  // only thing that's thinking about starting a scan.
  await enterEvent("triggerScan", reason, timeout);
  let newScanDeadline = Date.now() + (timeout || 0);
  if (timeout && newScanDeadline > scanDeadline) {
    debug(1, "triggerScan: next scan is too soon, ignoring trigger");
    await returnEvent("triggerScan", undefined, "next scan is too soon");
    return;
  }
  if (newScanDeadline > Date.now()) {
    delta = newScanDeadline - Date.now();
    debug(1, `triggerScan: scheduling scan for ${delta}ms in the future`);
    scanDeadline = newScanDeadline;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => triggerScan(reason), delta);
    await returnEvent("triggerScan", undefined, "set timer");
    return;
  }
  if (scanRunning) {
    debug(
      1,
      "triggerScan: scan time arrived while scan still running, ",
      "postponing for 5s",
    );
    scanDeadline = Date.now() + 5000;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => triggerScan("delayed"), 5000);
    await returnEvent("triggerScan", undefined, "scan in progress");
    return;
  }
  debug(1, "triggerScan: scanning now and queuing next scan for 60s from now");
  scanDeadline = Date.now() + 60000;
  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => triggerScan("periodic"), 60000);
  scanFoldersNow = scanFoldersOnDeck;
  scanFoldersOnDeck = [];
  scanRunning = true;
  scanFolders(reason);
  await returnEvent("triggerScan", undefined, "launched async scan");
}

function folderIsInList(folder, list) {
  return list.some(
    (f) => f.accountId == folder.accountId && f.path == folder.path,
  );
}

async function scanAccount(account, scanRegexp, reason) {
  await enterEvent("scanAccount", account.name, scanRegexp, reason);

  for (let folder of account.folders) {
    if (
      !(
        (scanRegexp && scanRegexp.test(folder.name)) ||
        folderIsInList(folder, scanFoldersNow)
      )
    )
      continue;

    let fqp = await folderPath(account, folder);
    let numSeen = 0;
    let numScanned = 0;
    let numChanged = 0;
    await debug(1, `Scanning for new messages in ${fqp}`);

    for await (let message of getMessages(messenger.messages.list(folder.id))) {
      if (seen.isMember(message.id)) {
        numSeen++;
        continue;
      }
      numScanned += 1;
      if (await checkMessage(message, account)) {
        await debug(1, `Changed message in ${reason} scan`);
        numChanged++;
      }
      seen.add(message.id);
    }

    scannedFolders[fqp] = true;

    let msg =
      `Scanned ${numScanned} messages in ${fqp}, ` +
      `changed ${numChanged}, ` +
      `skipped previously seen ${numSeen}`;
    if (numScanned) await infoEvent("scanAccount", msg);
    else if (numChanged || numSeen) await debug(1, msg);
  }
  await returnEvent("scanAccount");
}

async function scanFoldersBody(reason) {
  await enterEvent("scanFoldersBody", reason);

  let scanRegexp = await getPref(scanPref);
  if (scanRegexp) {
    try {
      scanRegexp = new RegExp(scanRegexp);
    } catch (ex) {
      await errorEvent(
        "scanFoldersBody",
        `Invalid scan regexp: "${scanRegexp}"`,
      );
      await returnEvent("scanFoldersBody", "invalid scan regexp");
      return;
    }
  }
  let accounts = await messenger.accounts.list();
  for (let account of accounts) {
    try {
      await scanAccount(account, scanRegexp, reason);
    } catch (ex) {
      await errorEvent(
        "scanFoldersBody",
        `Scan error for account ${account.name}`,
        ex,
      );
    }
  }
  await returnEvent("scanFoldersBody");
}

async function scanFolders(reason) {
  await enterEvent("scanFolders", reason);
  try {
    await scanFoldersBody(reason);
  } catch (ex) {
    await errorEvent("scanFolders", "Scan error:", ex);
  }
  scanRunning = false;
  await returnEvent("scanFolders");
}

async function checkNewMessages(folder, messages) {
  let fqp = await folderPath(null, folder);
  messages = await Array.fromAsync(getMessages(messages));
  let messageDescriptions = await Array.fromAsync(describeMessages(messages));
  messageDescriptions = "[" + messageDescriptions.join(", ") + "]";
  await enterEvent("checkNewMessages", fqp, messageDescriptions);

  for await (let message of messages) {
    if (seen.isMember(message.id)) {
      msg =
        `We've already seen supposedly new ` +
        `${await describeMessage(message)} in ${fqp}`;
      await errorEvent("checkNewMessages", msg);
      await registerAnomaly(msg);
      continue;
    }
    await checkMessage(message);
    seen.add(message.id);
  }

  folderString = await folderPath(null, folder);
  if (folderIsInList(folder, scanFoldersOnDeck)) {
    await debug(
      1,
      `checkNewMessages: Folder ${folderString} already in queue, `,
      "not queuing again",
    );
  } else {
    await debug(1, `checkNewMessages: Adding folder ${folderString} to queue`);
    scanFoldersOnDeck.push(folder);
  }

  await triggerScan("NewMailReceived");
  await returnEvent("checkNewMessages");
}

// account is specified when we are doing an account scan rather than
// checking a message we received an event about. I.e., we can assume that if
// account is empty, this check was triggered by an onNewMailReceived event.
async function checkMessage(message, account) {
  let currentPolicy = await browser.RemoteContent.getContentPolicy(message.id);
  if (currentPolicy != "None") {
    await debug(
      2,
      `Content policy for ${await describeMessage(message)} is ` +
        `set to "${currentPolicy}", not modifying`,
    );
    return false;
  }

  // Get newPolicy from regex match.
  let requestedPolicy = await getPolicyFromRegExMatch(message);
  if (requestedPolicy && currentPolicy != requestedPolicy) {
    await debug(
      1,
      `Switching content policy for ${await describeMessage(message)} ` +
        `from "${currentPolicy}" to "${requestedPolicy}"`,
    );
    await browser.RemoteContent.setContentPolicy(message.id, requestedPolicy);
    if (account) {
      let folder = message.folder;
      let fqp = await folderPath(account, folder);
      if (scannedFolders[fqp]) {
        msg =
          `Found new ${await describeMessage(message)} in ` +
          `${fqp} after first full scan of that folder; we should have been ` +
          `notified about it`;
        await errorEvent("checkMessage", msg);
        await registerAnomaly(msg);
      }
    }

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
        2,
        `Testing ${prefName} regexp "${regexp}" against folder name `,
        `"${msgHdr.folder.name}"`,
      );
      if (regexpObj.test(msgHdr.folder.name)) {
        await debug(
          2,
          `${prefName} regexp "${regexp}" matched folder name `,
          `"${msgHdr.folder.name}"`,
        );
        return true;
      }
      await debug(
        2,
        `${prefName} regexp "${regexp}" did not match folder name `,
        `"${msgHdr.folder.name}"`,
      );
      return false;
    } catch (ex) {
      await error(`Invalid regexp: "${regexp}"`);
      return false;
    }
  }

  await debug(2, `${prefName} is empty, not testing`);
  return false;
}

init();
