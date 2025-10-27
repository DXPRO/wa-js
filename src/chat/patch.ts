/*!
 * Copyright 2022 WPPConnect Team
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as webpack from '../webpack';
import { ChatModel, ContactStore, functions } from '../whatsapp';
import { wrapModuleFunction } from '../whatsapp/exportModule';
import {
  createChat,
  createChatRecord,
  findChat,
  getExisting,
  isUnreadTypeMsg,
  mediaTypeFromProtobuf,
  toUserLid,
  typeAttributeFromProtobuf,
} from '../whatsapp/functions';
import { Lid1X1MigrationUtils } from '../whatsapp/misc';

webpack.onFullReady(applyPatch, 1000);
webpack.onFullReady(applyPatchModel);

function applyPatch() {
  wrapModuleFunction(mediaTypeFromProtobuf, (func, ...args) => {
    const [proto] = args;
    if (proto.deviceSentMessage) {
      const { message: n } = proto.deviceSentMessage;
      return n ? mediaTypeFromProtobuf(n) : null;
    }
    if (proto.ephemeralMessage) {
      const { message: n } = proto.ephemeralMessage;
      return n ? mediaTypeFromProtobuf(n) : null;
    }
    if (proto.viewOnceMessage) {
      const { message: n } = proto.viewOnceMessage;
      return n ? mediaTypeFromProtobuf(n) : null;
    }

    return func(...args);
  });

  wrapModuleFunction(typeAttributeFromProtobuf, (func, ...args) => {
    const [proto] = args;

    if (proto.ephemeralMessage) {
      const { message: n } = proto.ephemeralMessage;
      return n ? typeAttributeFromProtobuf(n) : 'text';
    }
    if (proto.deviceSentMessage) {
      const { message: n } = proto.deviceSentMessage;
      return n ? typeAttributeFromProtobuf(n) : 'text';
    }
    if (proto.viewOnceMessage) {
      const { message: n } = proto.viewOnceMessage;
      return n ? typeAttributeFromProtobuf(n) : 'text';
    }

    return func(...args);
  });

  /**
   * Reinforce unread messages for buttons and lists
   */
  wrapModuleFunction(isUnreadTypeMsg, (func, ...args) => {
    const [msg] = args;

    switch (msg.type) {
      case 'buttons_response':
      case 'hsm':
      case 'list':
      case 'list_response':
      case 'template_button_reply':
        return true;
    }

    return func(...args);
  });

  wrapModuleFunction(createChatRecord, async (func, ...args) => {
    const [chatWid, chatOptions] = args;

    // CRITICAL: Always provide accountLid when isLidMigrated() is true
    if (
      Lid1X1MigrationUtils.isLidMigrated() &&
      chatOptions &&
      !(chatOptions as any).accountLid
    ) {
      try {
        // Try to convert to LID only if chatWid is a user and not already a LID
        let accountLid = chatWid;

        if (chatWid.isUser && chatWid.isUser() && !chatWid.isLid()) {
          const converted = toUserLid(chatWid);
          if (converted && converted.isLid && converted.isLid()) {
            accountLid = converted;
          }
        }

        (chatOptions as any).accountLid = accountLid.toString();
      } catch (error) {
        // Last resort: use chatWid itself

        (chatOptions as any).accountLid = chatWid.toString();
      }
    }

    const maxAttempts = 5;
    let delay = 1000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await func(...args);
      } catch (err) {
        if (attempt === maxAttempts) {
          throw err;
        }

        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
      }
    }
  });

  wrapModuleFunction(findChat, async (func, ...args) => {
    const [chatId] = args;

    // Only process LID chats
    if (!chatId.isLid()) {
      return await func(...args);
    }

    const contact = ContactStore.get(chatId);
    const existingChat = await getExisting(chatId);

    if (!existingChat && contact) {
      const chatParams: any = { chatId };

      // Add accountLid if migrated to LID system
      if (Lid1X1MigrationUtils.isLidMigrated()) {
        try {
          // chatId is already a LID, use it directly
          chatParams.accountLid = chatId.toString();
        } catch (error) {}
      }

      try {
        await createChat(
          chatParams,
          'createChat',
          {
            createdLocally: true,
            lidOriginType: 'general',
          },
          {}
        );

        // Wait for chat to be created and indexed
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Try to get the chat directly from store
        const newChat = await getExisting(chatId);
        if (newChat) {
          return newChat;
        }
      } catch (error) {}
    }

    return await func(...args);
  });

  // Evita erro "No LID for user" ao chamar toUserLidOrThrow
  try {
    if (typeof functions.toUserLidOrThrow === 'function') {
      wrapModuleFunction(functions.toUserLidOrThrow, (_func, ...args) => {
        const [UserWid] = args;
        try {
          const LID = toUserLid ? toUserLid(UserWid) : null;
          return LID || UserWid;
        } catch {
          return UserWid;
        }
      });
    }
  } catch {}
}

function applyPatchModel() {
  const funcs: {
    [key: string]: (...args: any[]) => any;
  } = {
    shouldAppearInList: functions.getShouldAppearInList,
    isUser: functions.getIsUser,
    isPSA: functions.getIsPSA,
    isGroup: functions.getIsGroup,
    isNewsletter: functions.getIsNewsletter,
    previewMessage: functions.getPreviewMessage,
    showChangeNumberNotification: functions.getShowChangeNumberNotification,
    hasUnread: functions.getHasUnread,
  };

  for (const attr in funcs) {
    const func = funcs[attr];
    if (typeof (ChatModel.prototype as any)[attr] === 'undefined') {
      Object.defineProperty(ChatModel.prototype, attr, {
        get: function () {
          return func(this);
        },
        configurable: true,
      });
    }
  }
}
