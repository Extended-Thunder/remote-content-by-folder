/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

"use strict";

// Using a closure to not leak anything but the API to the outside world.
(function (exports) {

   var { DeferredTask } = ChromeUtils.importESModule(
      "resource://gre/modules/DeferredTask.sys.mjs"
   );
   var { EventEmitter } = ChromeUtils.importESModule(
      "resource://gre/modules/EventEmitter.sys.mjs"
   );
   var { MailServices } = ChromeUtils.importESModule(
      "resource:///modules/MailServices.sys.mjs"
   );

   class NewMessagesTracker extends EventEmitter {
      constructor() {
         super();

         // Members to track new messages.
         this._knownNewMessages = new Set();
         this._pendingNewMessages = new ExtensionUtils.DefaultMap(() => []);
         this._deferredNewMessagesNotifications = new ExtensionUtils.DefaultMap(
            folder =>
               new DeferredTask(
                  () => this.emitPendingNewMessages(folder),
                  200
               )
         );

         // nsIMsgFolderListener
         MailServices.mfn.addListener(
            this,
            MailServices.mfn.msgAdded
         );

         // nsIFolderListener
         MailServices.mailSession.AddFolderListener(
            this,
            Ci.nsIFolderListener.propertyFlagChanged
         );
      }

      addPendingNewMessage(msgHdr) {
         if (this._knownNewMessages.has(msgHdr.messageId)) {
            return;
         }
         this._knownNewMessages.add(msgHdr.messageId);

         const folder = msgHdr.folder;
         this._pendingNewMessages.get(folder).push(msgHdr.subject);
         this._deferredNewMessagesNotifications.get(folder).disarm();
         this._deferredNewMessagesNotifications.get(folder).arm();
      }

      emitPendingNewMessages(folder) {
         const pendingNewMessages = this._pendingNewMessages.get(folder);
         if (pendingNewMessages.length > 0) {
            this.emit("ex-messages-received", folder, pendingNewMessages);
            this._pendingNewMessages.delete(folder);
         }
      }

      cleanup() {
         // nsIMsgFolderListener
         MailServices.mfn.removeListener(this);
         // nsIFolderListener
         MailServices.mailSession.RemoveFolderListener(this);
      }

      /**
       * Implements nsIMsgFolderListener.msgAdded().
       *
       * @param {nsIMsgDBHdr} msgHdr
       */
      msgAdded(msgHdr) {
         // If this is a new message, add it to the next ex- messages-received event.
         if (msgHdr.flags & Ci.nsMsgMessageFlags.New) {
            this.addPendingNewMessage(msgHdr);
         }
      }

      /**
       * Implements nsIFolderListener.onFolderPropertyFlagChanged().
       *
       * @param {nsIMsgDBHdr} msgHdr
       * @param {string} property
       * @param {integer} oldFlag
       * @param {integer} newFlag
       */
      onFolderPropertyFlagChanged(msgHdr, property, oldFlag, newFlag) {
         const newProperties = {};
         switch (property) {
            case "Status":
               if ((oldFlag ^ newFlag) & Ci.nsMsgMessageFlags.New) {
                  newProperties.new = !!(newFlag & Ci.nsMsgMessageFlags.New);
                  // Remove message from the list of known new messages.
                  if (!newProperties.new) {
                     this._knownNewMessages.delete(msgHdr.messageId);
                  }
               }
               break;
         }
      }
   }

   var newMessagesTracker = new NewMessagesTracker();

   var ex_messages = class extends ExtensionCommon.ExtensionAPI {
      getAPI(context) {
         return {
            ex_messages: {
               onNewMailReceived: new ExtensionCommon.EventManager({
                  context,
                  name: "ex_messages.onNewMailReceived",
                  register: (fire, monitorAllFolders) => {
                     const listener = async (event, folder, messageSubjects) => {
                        const { extension } = this;
                        if (fire.wakeup) {
                           await fire.wakeup();
                        }
                        // Evaluate sensitivity.
                        const flags = folder.flags;
                        const isInbox = f => f & Ci.nsMsgFolderFlags.Inbox;
                        const isNormal = f =>
                           !(f & (Ci.nsMsgFolderFlags.SpecialUse | Ci.nsMsgFolderFlags.Virtual));
                        if (monitorAllFolders || isInbox(flags) || isNormal(flags)) {
                           fire.async(extension.folderManager.convert(folder), messageSubjects);
                        }
                     };
                     newMessagesTracker.on("ex-messages-received", listener);
                     return () => {
                        newMessagesTracker.off("ex-messages-received", listener);
                     };
                  },
               }).api(),
            },
         };
      }
      onShutdown(isAppShutdown) {
         newMessagesTracker.cleanup();
      }
   };

   exports.ex_messages = ex_messages;
})(this);