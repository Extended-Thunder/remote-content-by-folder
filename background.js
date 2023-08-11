const DEBUG = false;
const PREF_PREFIX = "extensions.remote-content-by-folder.";

const allowPref = "allow_regexp";
const blockPref = "block_regexp";
const blockFirstPref = "block_first";

const PREF_DEFAULTS = {
    "logging.console": "Warn", // Unused
    "logging.dump": "Fatal", // Unused
    [allowPref]: "",
    [blockPref]: "",
    [blockFirstPref]: false,
}

function debug(msg) {
    if (DEBUG) {
        console.log("RCBF:", msg);
    }
}

async function init() {
    // TODO: Migrate LegacyPrefs to local storage.
    let prefs = {};
    for (let [name, value] of Object.entries(PREF_DEFAULTS)) {
        await browser.LegacyPrefs.setDefaultPref(`${PREF_PREFIX}${name}`, value);
        prefs[name] = await browser.LegacyPrefs.getPref(`${PREF_PREFIX}${name}`);
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
        debug(`Content policy for message "${message.id}" is set to "${currentPolicy}", not modifying`);
        return;
    }

    // Get newPolicy from regex match.
    let requestedPolicy = await getPolicyFromRegExMatch(message);
    if (requestedPolicy && currentPolicy != requestedPolicy) {
        debug(`Switching content policy for message "${message.id}" from "${currentPolicy}" to "${requestedPolicy}"`);
        await browser.RemoteContent.setContentPolicy(message.id, requestedPolicy);
    }
};

async function getPolicyFromRegExMatch(message) {
    let blockFirst = await browser.LegacyPrefs.getPref(`${PREF_PREFIX}${blockFirstPref}`);
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
    let regexp = await browser.LegacyPrefs.getPref(`${PREF_PREFIX}${prefName}`);
    if (regexp != "") {
        try {
            let regexpObj = new RegExp(regexp);
            debug(`Testing ${prefName} regexp "${regexp}" against folder name "${msgHdr.folder.name}"`);
            if (regexpObj.test(msgHdr.folder.name)) {
                debug(`${prefName} regexp "${regexp}" matched folder name "${msgHdr.folder.name}"`);
                return true;
            }
            debug(`${prefName} regexp "${regexp}" did not match folder name "${msgHdr.folder.name}"`);
            return false;
        } catch (ex) {
            console.error(`Invalid regexp: "${regexp}"`);
            return false;
        }
    }

    debug(`${prefName} is empty, not testing`);
    return false;
}

init();
