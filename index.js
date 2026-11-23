import { findByProps, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher } from "@vendetta/metro/common";
import { before } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { showToast } from "@vendetta/ui/toasts";

const RestAPI = findByProps("get", "put", "post", "del");
const PermissionStore = findByStoreName("PermissionStore");
const ChannelStore = findByStoreName("ChannelStore");
const Permissions = findByProps("ADD_REACTIONS", "SEND_MESSAGES");

// 저장소 초기화: { "채널ID": { "유저ID": "이모지" } }
storage.targets ??= {};

let unpatchSend;

// 채널에 반응을 달 수 있는지 권한 확인 함수
function canReactInChannel(channelId) {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return false;
    // DM이나 그룹DM은 기본 허용
    if (channel.type === 1 || channel.type === 3) return true;
    // 서버 채널인 경우 ADD_REACTIONS(0x40n) 권한 체크
    const addReactionPerm = Permissions?.ADD_REACTIONS ?? (1n << 6n);
    return PermissionStore.can(addReactionPerm, channel);
}

// 커스텀 이모지 및 일반 이모지를 API 포맷으로 변환
function parseEmoji(raw) {
    const customMatch = raw.match(/<a?:([^:]+:\d+)>/);
    if (customMatch) {
        return encodeURIComponent(customMatch[1]);
    }
    return encodeURIComponent(raw.trim());
}

// 메시지 수신 시 즉시 반응 실행 핸들러
async function onMessageCreate(event) {
    const { message, channelId } = event;
    if (!message || !message.author) return;

    const channelTargets = storage.targets[channelId];
    if (!channelTargets) return;

    const rawEmoji = channelTargets[message.author.id];
    if (!rawEmoji) return;

    // 반응을 달 수 없는 채널이면 즉시 취소
    if (!canReactInChannel(channelId)) return;

    const encodedEmoji = parseEmoji(rawEmoji);

    try {
        // 딜레이 없이 즉시 API 요청
        await RestAPI.put({
            url: `/channels/${channelId}/messages/${message.id}/reactions/${encodedEmoji}/@me`
        });
    } catch (e) {
        console.error("[AutoReact] 반응 실패:", e);
    }
}

export default {
    onLoad() {
        const MessageActions = findByProps("sendMessage", "receiveMessage");

        // 채팅 전송을 가로채서 명령어로 처리
        unpatchSend = before("sendMessage", MessageActions, (args) => {
            const channelId = args[0];
            const messageObj = args[1];
            const content = messageObj?.content?.trim();

            if (!content) return;

            // 1. /반응추가 <유저멘션 또는 ID> <이모지>
            if (content.startsWith("/반응추가 ") || content.startsWith("!반응추가 ")) {
                args[1].content = ""; // 실제 채팅창에 메시지가 전송되지 않게 차단

                if (!canReactInChannel(channelId)) {
                    showToast("❌ 이 채널에는 반응을 달 수 있는 권한이 없어 취소되었습니다.");
                    return false;
                }

                const parts = content.split(/\s+/);
                if (parts.length < 3) {
                    showToast("⚠️ 사용법: /반응추가 @유저 이모지");
                    return false;
                }

                // 멘션(<@12345>) 또는 순수 ID에서 숫자만 추출
                const userId = parts[1].replace(/[<@!>]/g, "");
                const emoji = parts[2];

                if (!/^\d+$/.test(userId)) {
                    showToast("⚠️ 올바른 유저 멘션이나 ID를 입력해주세요.");
                    return false;
                }

                storage.targets[channelId] ??= {};
                storage.targets[channelId][userId] = emoji;

                showToast(`✅ 현재 채널에서 [${userId}]님에게 ${emoji} 자동 반응이 설정되었습니다.`);
                return false;
            }

            // 2. /반응제거 <유저멘션 또는 ID> (또는 /반응초기화)
            if (content.startsWith("/반응제거") || content.startsWith("!반응제거")) {
                args[1].content = "";
                const parts = content.split(/\s+/);

                if (parts[1]) {
                    const userId = parts[1].replace(/[<@!>]/g, "");
                    if (storage.targets[channelId]?.[userId]) {
                        delete storage.targets[channelId][userId];
                        showToast(`🗑️ 현재 채널에서 [${userId}] 자동 반응을 해제했습니다.`);
                    } else {
                        showToast("⚠️ 해당 유저는 등록되어 있지 않습니다.");
                    }
                } else {
                    delete storage.targets[channelId];
                    showToast("🗑️ 현재 채널의 모든 자동 반응을 초기화했습니다.");
                }
                return false;
            }
        });

        FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
    },

    onUnload() {
        if (unpatchSend) unpatchSend();
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
    }
};
