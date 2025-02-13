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

var thunderbirdVersion = false;

async function tbIsVersion(wantVersion, yes, no) {
  if (typeof wantVersion == "number") {
    wantVersion = [wantVersion];
  }

  if (!thunderbirdVersion) {
    let browserInfo = await messenger.runtime.getBrowserInfo();
    thunderbirdVersion = browserInfo.version.split(".").map(parseInt);
  }

  let tbVersion = [...thunderbirdVersion];
  let satisfied = true;
  while (wantVersion.length) {
    let wantFirst = wantVersion.shift();
    let tbFirst = tbVersion.shift();
    if (wantFirst > tbFirst) {
      satisfied = false;
      break;
    }
    if (wantFirst < tbFirst) {
      break;
    }
  }

  if (satisfied) {
    if (yes) {
      if (typeof yes == "function") {
        return yes();
      } else {
        return yes;
      }
    }
  } else {
    if (no) {
      if (typeof no == "function") {
        return no();
      } else {
        return no;
      }
    }
  }
}

async function tb128(yes, no) {
  return await tbIsVersion(128, yes, no);
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
    }
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

  messenger.messages.onNewMailReceived.addListener(checkNewMessages, true);
  await scanFolders("startup");
}

async function scanAccount(account, scanRegexp, reason) {
  for (let folder of account.folders) {
    if (!(scanRegexp && scanRegexp.test(folder.name))) continue;
    let numScanned = 0;
    let numChanged = 0;
    await debug(
      1,
      `Scanning for new messages in ${account.name}${folder.path}`,
    );
    let page = await messenger.messages.list(
      await tb128(
        () => folder.id,
        () => folder,
      ),
    );
    while (true) {
      for (let message of page.messages) {
        numScanned += 1;
        if (await checkMessage(message)) {
          await debug(1, `Changed message in ${reason} scan`);
          numChanged++;
        }
      }
      if (!page.id) break;
      page = await messenger.messages.continueList(page.id);
    }
    await debug(
      1,
      `Scanned ${numScanned} messages in ${account.name}` +
        `${folder.path}, changed ${numChanged}`,
    );
  }
}

async function scanFoldersBody(reason) {
  let scanRegexp = await getPref(scanPref);
  if (scanRegexp) {
    try {
      scanRegexp = new RegExp(scanRegexp);
    } catch (ex) {
      await error(`Invalid scan regexp: "${scanRegexp}"`);
      return;
    }
  }
  let accounts = await messenger.accounts.list();
  for (let account of accounts) {
    try {
      await scanAccount(account, scanRegexp, reason);
    } catch (ex) {
      await error(`Scan error for account ${account.name}`, ex);
    }
  }
}

async function scanFolders(reason) {
  await debug(1, `scanFolders(${reason})`);
  let result;
  try {
    result = await scanFoldersBody(reason);
  } catch (ex) {
    await error("Scan error:", ex);
  }
}

async function* getMessages(list) {
  await debug(2, list);
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

async function checkNewMessages(folder, messages) {
  folderString = `${folder.accountId}${folder.path}`;
  await debug(1, `checkNewMessages: checking messages in ${folderString}`);
  for await (const message of getMessages(messages)) {
    await checkMessage(message);
  }
}

async function checkMessage(message) {
  let currentPolicy = await browser.RemoteContent.getContentPolicy(message.id);
  if (currentPolicy != "None") {
    await debug(
      2,
      `Content policy for message ${message.id} ("${message.subject}") is ` +
        `set to "${currentPolicy}", not modifying`,
    );
    return false;
  }

  // Get newPolicy from regex match.
  let requestedPolicy = await getPolicyFromRegExMatch(message);
  if (requestedPolicy && currentPolicy != requestedPolicy) {
    await debug(
      1,
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
