export const COMPUTER_VOCABULARY = Object.freeze([
  "Orca", "Orca 会话", "会话", "Codex", "ESP32", "session", "电脑任务",
]);

const orca = "(?:(?<![A-Za-z0-9])Orca(?![A-Za-z0-9])|奥卡|欧卡)";
const mention = new RegExp(orca, "iu");
const ending = "(?=\\s*(?:$|[，,：:]|有|的?(?:数量|列表)|现在|目前|一共|总共|还|都|是|啊|呀|呢|吗))";
const namedSessions = new RegExp(`(${orca}\\s*(?:(?:里(?:面)?|中|上|的)\\s*)?)绘画${ending}`, "giu");
const countedSessions = new RegExp(`((?:多少|几)\\s*(?:个|条|段)\\s*)绘画${ending}`, "gu");

// A narrow fallback for the observed 会话/绘画 homophone. Never teach a global
// dictionary replacement: Orca can also be used for actual artwork requests.
export function correctComputerTranscript(text) {
  if (/[“”「」『』"'《》]|翻译|复述|原文|转写|识别成|这个词|这句话|他说|她说/.test(text)) return text;
  return text.replace(/[^。！？!?；;\r\n]+/gu, sentence => {
    if (!mention.test(sentence) || !/多少|几个|几条|几段|数量|列表|列出|列一下/.test(sentence)) return sentence;
    if (/绘画\s*(?:文件|作品|任务|功能|风格|教程|课程|素材)|画作|插画|画图|绘图|绘制|美术|油画|水彩|图画|图片|图像|几张|几幅|多少张|多少幅/.test(sentence)) return sentence;
    return sentence.replace(namedSessions, "$1会话").replace(countedSessions, "$1会话");
  });
}
