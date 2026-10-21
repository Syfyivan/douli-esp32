import { streamChat } from "./providers.mjs";
import { chatProfile } from "./routing.mjs";

// Unknown speakers get one stateless turn. No Store, personal prompt, history,
// memory, vision or tools enter this path, even after a known speaker's turn.
export async function guestReply(settings, text, signal, emit = () => {}) {
  const now = new Date();
  const runtime = {
    assistantName: settings.assistant.name,
    localTime: new Intl.DateTimeFormat("zh-CN", { dateStyle: "full", timeStyle: "long" }).format(now),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    requestedModel: settings.models.daily.model,
  };
  const messages = [
    { role: "system", content: `你是一个中文语音助手，自然、简短地回答本轮问题，普通问题一到三句即可，不用 Markdown，不固定追加反问。
本轮尚未确认说话人的身份，照常回答普通问题，不要求对方先通过声纹识别。你只收到本轮语音转写，没有原始音频、画面、历史对话、个人档案、偏好或记忆，也没有任何可调用工具。
不要猜测对方是谁，不编造过去的聊天或个人信息。涉及查询、保存、修改个人资料或记忆时，说明本轮未访问或保存个人资料，可在页面选择自己的档案后操作。不能声称已记住、修改、删除资料或控制了设备。
用户问能否听见时，直接自然回应已收到这句话，不主动解释语音识别或转写机制，也不主动播报身份尚未确认。不能凭转写声称判断了音质、环境、情绪或身体状况。没有联网查询能力，不虚构已搜索的实时信息。
用户明确想结束本次聊天时，简短道别，不追加问题；待机由程序处理。仅提及告别、询问词义或明确说先别结束时，继续正常回答。
以下是程序提供的运行信息：${JSON.stringify(runtime)}` },
    { role: "user", content: text },
  ];
  let received = false;
  for await (const event of streamChat(chatProfile(settings), messages, signal)) {
    signal?.throwIfAborted();
    if (event.type === "text" && event.text) {
      received = true;
      emit({ type: "delta", text: event.text });
    }
  }
  if (!received) throw new Error("普通对话模型没有返回回答，请稍后重试");
  return { farewell: false };
}
