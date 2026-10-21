const farewell = /^(?:晚安|再见|拜拜|结束(?:这次|本次)?(?:对话|会话)|停止聊天|先?不聊了|(?:今天|这次)?(?:就|先)?聊到(?:这里|这儿|这))[啊呀啦了吧哦]{0,2}$/u;
const normalize = text => text.normalize("NFKC").replace(/[\s，,。.!！?？]/gu, "");
const polite = text => text
  .replace(/^(?:(?:嗯+|呃+|哦|噢|好(?:的|了|吧|啦)?|行(?:了|吧)?|那(?:就)?|谢谢(?:你)?))+/u, "")
  .replace(/(?:谢谢(?:你)?)+$/u, "");

export function isFarewell(text, assistantName = "豆梨") {
  if (typeof text !== "string") return false;
  // Only complete commands qualify. Keep quotes, negations and extra clauses
  // intact; a farewell mentioned in a question/story must not end the session.
  const phrase = polite(normalize(text));
  if (farewell.test(phrase)) return true;
  // These two aliases were confirmed from real ASR failures. Scope them to
  // addressing the assistant in a command, never rewrite ordinary conversation.
  const names = new Set(["豆梨", "都丽", "都离", normalize(assistantName)]);
  for (const name of names) {
    if (!name) continue;
    if (phrase.startsWith(name) && farewell.test(polite(phrase.slice(name.length)))) return true;
    if (phrase.endsWith(name) && farewell.test(polite(phrase.slice(0, -name.length)))) return true;
  }
  return false;
}
