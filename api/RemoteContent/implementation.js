// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright 2017 Jonathan Kamens.

var { ExtensionParent } = ChromeUtils.import(
  "resource://gre/modules/ExtensionParent.jsm",
);
var { ExtensionSupport } = ChromeUtils.import(
  "resource:///modules/ExtensionSupport.jsm",
);

// From nsMsgContentPolicy.cpp
const kNoRemoteContentPolicy = 0;
const kBlockRemoteContent = 1;
const kAllowRemoteContent = 2;

const contentPolicyProperty = "remoteContentPolicy";
const policyMap = [
  {
    id: kNoRemoteContentPolicy,
    name: "None",
  },
  {
    id: kBlockRemoteContent,
    name: "Block",
  },
  {
    id: kAllowRemoteContent,
    name: "Allow",
  },
];

function getMessageWindow(nativeTab) {
  if (nativeTab instanceof Ci.nsIDOMWindow) {
    return nativeTab.messageBrowser.contentWindow;
  } else if (nativeTab.mode && nativeTab.mode.name == "mail3PaneTab") {
    return nativeTab.chromeBrowser.contentWindow.messageBrowser.contentWindow;
  } else if (nativeTab.mode && nativeTab.mode.name == "mailMessageTab") {
    return nativeTab.chromeBrowser.contentWindow;
  }
  return null;
}

var RemoteContent = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    return {
      RemoteContent: {
        getContentPolicy: function (messageId) {
          let realMessage = context.extension.messageManager.get(messageId);
          let policyId = realMessage.getUint32Property(contentPolicyProperty);
          let policy = policyMap.find((e) => e.id == policyId);
          if (!policy) {
            throw new Error(`Unknown policy id ${policyId}`);
          }
          return policy.name;
        },

        setContentPolicy: async function (messageId, policyName) {
          let realMessage = context.extension.messageManager.get(messageId);
          let newPolicy = policyMap.find((e) => e.name == policyName);
          if (!newPolicy) {
            throw new Error(`Unknown policy name ${policyName}`);
          }

          let oldPolicyId = realMessage.getUint32Property(
            contentPolicyProperty,
          );
          if (newPolicy.id == oldPolicyId) {
            return;
          }
          realMessage.setUint32Property(contentPolicyProperty, newPolicy.id);
        },

        reloadMessage: async function (tabId) {
          let { nativeTab } = context.extension.tabManager.get(tabId);
          let messageBrowserWindow = getMessageWindow(nativeTab);
          if (!messageBrowserWindow) {
            return;
          }
          await messageBrowserWindow.ReloadMessage();
        },
      },
    };
  }
};
