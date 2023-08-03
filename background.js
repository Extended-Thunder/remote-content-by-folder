const DEBUG = false;
const PREF_PREFIX = "extensions.remote-content-by-folder.";

const allowPref = "allow_regexp";
const blockPref = "block_regexp";
const blockFirstPref = "block_first";
const allowOnlyTempPref = "allow_temporary_only";

const PREF_DEFAULTS = {
    "logging.console": "Warn", // Unused
    "logging.dump": "Fatal", // Unused
    [allowPref]: "",
    [blockPref]: "",
    [blockFirstPref]: false,
    [allowOnlyTempPref]: false,
}
let allowedLog = new Map();

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

    // Check all already open messages.
    let messageTabs = await browser.tabs.query().then(tabs => tabs.filter(t => ["mail", "messageDisplay"].includes(t.type)));
    for (let messageTab of messageTabs) {
        let message = await browser.messageDisplay.getDisplayedMessage(messageTab.id);
        if (message) {
            await checkMessage(messageTab, message);
        }
    }

    // Check any message being opened in the future.
    browser.messageDisplay.onMessageDisplayed.addListener(checkMessage);
}

// If a message is displayed and the current policy does not match the expected
// policy, we update the policy and reload the message.
async function checkMessage(tab, message) {
    // If a message is in the allowed log, than it has been changed recently to
    // allow remote content. The message is therefore intended to be viewed with
    // remote content allowed and no action on the message should be taken here,
    // except to delay the removal from the log for anti-glitch measures.
    let logEntry = allowedLog.get(message.id);
    if (logEntry) {
        window.clearTimeout(logEntry);
        logEntry = scheduleRemovalFromAllowedLog(message.id);
        return;
    }

    let currentPolicy = await browser.RemoteContent.getContentPolicy(message.id);
    if (currentPolicy == "None") {
        debug(`Property "${contentPolicyProperty}" on message "${message.id}" set to "${currentPolicy}", not modifying`);
        return;
    }

    // Get newPolicy from regex match.
    let requestedPolicy = await getPolicyFromRegExMatch(message);
    if (currentPolicy != requestedPolicy) {
        // Make sure to remove us from the allowed log after some time.
        if (requestedPolicy == "Allow") {
            allowedLog.set(message.id, scheduleRemovalFromAllowedLog(message.id));
        }

        debug(`Switching policy from "${currentPolicy}" to "${requestedPolicy}" for message "${message.id}"`);
        await browser.RemoteContent.setContentPolicy(message.id, requestedPolicy);
        await browser.RemoteContent.reloadMessage(tab.id);
    }
};

// Keep track of recently allowed messages, to avoid glitches of messages being
// reloaded multiple times.
function scheduleRemovalFromAllowedLog(messageId) {
    debug(`Scheduling for being removed from the allowedLog later: ${messageId}`)
    return window.setTimeout(async () => {
        debug(`Removing from allowedLog: ${messageId}`);
        allowedLog.delete(messageId);

        let allowTemp = await browser.LegacyPrefs.getPref(`${PREF_PREFIX}${allowOnlyTempPref}`);
        if (allowTemp) {
            debug(`Returning message policy to BLOCK: ${messageId}`);
            await browser.RemoteContent.setContentPolicy(messageId, "Block")
        }
    }, 10000);
}

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

    return "Block"

    // This is not needed, if we have not yet been allowed, we default to block.
    if (!blockFirst) {
        if (await checkRegexp(message, blockPref)) {
            return "Block";
        }
    }
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
