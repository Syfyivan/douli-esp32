const farewell = /^(?:晚安|再见|拜拜|结束对话|停止聊天)[啊呀啦了吧哦]?$/u;
const normalize = text => text.normalize("NFKC").replace(/[\s，,。.!！?？]/gu, "");

export function isFarewell(text, assistantName = "豆梨") {
  if (typeof text !== "string") return false;
  // Only complete commands qualify. Keep quotes, negations and extra clauses
  // intact; a farewell mentioned in a question/story must not end the session.
  const phrase = normalize(text);
  if (farewell.test(phrase)) return true;
  // These two aliases were confirmed from real ASR failures. Scope them to
  // addressing the assistant in a command, never rewrite ordinary conversation.
  const names = new Set(["豆梨", "都丽", "都离", normalize(assistantName)]);
  for (const name of names) {
    if (!name) continue;
    if (phrase.startsWith(name) && farewell.test(phrase.slice(name.length))) return true;
    if (phrase.endsWith(name) && farewell.test(phrase.slice(0, -name.length))) return true;
  }
  return false;
}
