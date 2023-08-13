const PREF_PREFIX = "extensions.remote-content-by-folder.";

const debugPref = "debug";
const allowPref = "allow_regexp";
const blockPref = "block_regexp";
const blockFirstPref = "block_first";

const PREF_DEFAULTS = {
  [debugPref]: false,
  [allowPref]: "",
  [blockPref]: "",
  [blockFirstPref]: false,
};

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

async function init() {
  // TODO: Migrate LegacyPrefs to local storage.
  let prefs = {};
  for (let [name, value] of Object.entries(PREF_DEFAULTS)) {
    await browser.LegacyPrefs.setDefaultPref(`${PREF_PREFIX}${name}`, value);
  }

  messenger.messages.onNewMailReceived.addListener(checkNewMessages);
}

async function checkNewMessages(folder, messages) {
  for (let message of messages.messages) {
    await checkMessage(message);
  }
}

async function checkMessage(message) {
  let currentPolicy = await browser.RemoteContent.getContentPolicy(message.id);
  if (currentPolicy != "None") {
    await debug(
      `Content policy for message ${message.id} ("${message.subject}") is set to "${currentPolicy}", not modifying`,
    );
    return;
  }

  // Get newPolicy from regex match.
  let requestedPolicy = await getPolicyFromRegExMatch(message);
  if (requestedPolicy && currentPolicy != requestedPolicy) {
    await debug(
      `Switching content policy for message ${message.id} ("${message.subject}") from "${currentPolicy}" to "${requestedPolicy}"`,
    );
    await browser.RemoteContent.setContentPolicy(message.id, requestedPolicy);
  }
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
      console.error(`Invalid regexp: "${regexp}"`);
      return false;
    }
  }

  await debug(`${prefName} is empty, not testing`);
  return false;
}

init();
