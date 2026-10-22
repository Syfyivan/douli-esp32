import { routes } from "./config.mjs";
import { needsWebSearch, forbidsWebSearch } from "./web-search.mjs";

const health = /医学|医疗|健康|症状|看病|生病|用药|药物|药量|处方|停药|吃药|疼痛|头痛|胸痛|腹痛|牙痛|发烧|发热|诊断|失眠|血压|过敏|怀孕|孕期|哺乳|检查报告|化验|副作用|medicine|medical|symptom|dosage/i;
const learning = /学习|学会|教我|科普|讲解|讲讲|原理|课程|知识|入门|learn|teach|explain/i;
const reasoning = /解题|证明|推导|算法|数学|代码|编程|分析|计算|debug|algorithm/i;
const debate = /争论|判官|谁对|谁错|辩论|各执一词|辨析/;
const personal = /(?:我|家人|孩子|宝宝|父母|妈妈|爸爸).*(?:吃药|停药|换药|用药|药量|剂量|手术|怀孕|投资|贷款|离职|辞职|签合同)|该不该|要不要.*(?:药|手术|投资|贷款|辞职)|能.*(?:一起吃|停药|加量)/;
const continuation = /^(?:那|那么)?(?:继续(?:讲|说|解释)?|详细(?:一点|解释一下|讲讲)|展开(?:讲讲|说说)?|举个例子|再举个例子|为什么(?:呢)?|怎么理解|具体(?:呢|怎么做|应该怎么办)|应该怎么办|然后呢|还有呢|这个(?:呢|是什么意思)|那怎么办)[呀啊呢吧?？。！!\s]*$/;

// Local topic hints only: preserve prompts and the encrypted health workflow.
// Topics never choose a different model or make a classification API request.
export function chooseRoute(text, requested = "auto") {
  if (routes.includes(requested)) return requested;
  if (health.test(text)) return "health";
  if (debate.test(text)) return "debate";
  if (reasoning.test(text)) return "reasoning";
  if (learning.test(text)) return "learning";
  return "daily";
}

export function chatProfile(settings) {
  return { ...settings.models.daily, thinking: false };
}

export async function routeRequest({ text, requested = "auto", history = [], settings, signal }) {
  signal?.throwIfAborted();
  const previous = history.findLast(m => m.status === "complete" && m.role === "assistant");
  const previousTopic = previous?.metadata?.routing?.route || previous?.route;
  const continued = !routes.includes(requested) && routes.includes(previousTopic) && continuation.test(text.trim());
  const route = continued ? previousTopic : chooseRoute(text, requested);
  const personalDecision = personal.test(text) || (continued && !!previous?.metadata?.routing?.personalDecision);
  const profile = chatProfile(settings);
  return {
    profile,
    // Keep the event/history shape compatible with existing clients and records.
    metadata: {
      version: 2, route, profileKey: "daily", model: profile.model || "",
      tier: "fast", thinking: false, source: "fixed", reason: "统一使用对话模型",
      classifierStatus: "disabled", classifierModel: null, routingMs: 0,
      continuation: continued, personalDecision,
      needsSearch: !forbidsWebSearch(text) && ((route === "health" && personalDecision) || needsWebSearch(text)),
      degraded: false, degradation: null,
    },
  };
}
