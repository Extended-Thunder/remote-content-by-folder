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
let lastAllowedMessages = new Map();

function debug(msg) {
    //console.log(msg);
}

// We want all messages to default to BLOCK, so we return them to BLOCK after a
// timeout.
function scheduleBlock(messageId) {
    debug("Scheduling for returning to BLOCK later", messageId)
    return window.setTimeout(() => {
        debug("Returning to BLOCK", messageId);
        lastAllowedMessages.delete(messageId);
        browser.RemoteContent.setContentPolicy(messageId, "Block")
    }, 20000);
}

async function init() {
    // TODO: Migrate old LegacyPrefs to local storage.
    let prefs = {};
    for (let [name, value] of Object.entries(PREF_DEFAULTS)) {
        await browser.LegacyPrefs.setDefaultPref(`${PREF_PREFIX}${name}`, value);
        prefs[name] = await browser.LegacyPrefs.getPref(`${PREF_PREFIX}${name}`);
    }

    // If a message is displayed and the current policy does not match the expected
    // policy, we update the policy and reload the message.
    browser.messageDisplay.onMessageDisplayed.addListener(async (tab, message) => {
        // If a message is in lastAllowedMessages, than it has been 
        // - set to allow remote content recently
        // - not yet been set back to block remote content
        // The message is therefore intended to be viewed with remote content
        // allowed and no action on the message should be taken here, except to
        // delay the blocking set-back for anti-glitch measures.
        let lastAllowedMessage = lastAllowedMessages.get(message.id);
        if (lastAllowedMessage) {
            window.clearTimeout(lastAllowedMessage.timeoutHandler);
            lastAllowedMessage.timeoutHandler = scheduleBlock(message.id);
            return;
        }

        let currentPolicy = await browser.RemoteContent.getContentPolicy(message.id);
        if (currentPolicy == "None") {
            debug(`Property "${contentPolicyProperty}" on message "${message.id}" set to "${currentPolicy}", not modifying`);
            return;
        }

        // Get newPolicy from settings.
        let requestedPolicy = await getRequestedPolicy(message);

        // Make sure we return to BLOCK after some time.
        if (requestedPolicy == "Allow") {
            lastAllowedMessages.set(message.id, {
                tabId: tab.id,
                timeoutHandler: scheduleBlock(message.id),
            });
        }

        if (currentPolicy != requestedPolicy) {
            debug(`Setting policy ${requestedPolicy}`);
            await browser.RemoteContent.setContentPolicy(message.id, requestedPolicy);
            await browser.RemoteContent.reloadMessage(tab.id);
        }
    });
}
init();

// Regex code

async function getRequestedPolicy(message) {
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
