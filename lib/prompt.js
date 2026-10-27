/**
 * The meta prompt and the request framing it belongs to.
 *
 * Kept apart from the transport so the instruction can be revised without
 * touching the HTTP route, the timeout policy, or the client half.
 *
 * @module dsh-prompt-enhance/prompt
 */

/**
 * Instruction sent as the model's `system` message.
 *
 * Rules encoded here are the ones the feature is judged by: keep the user's
 * meaning and language, invent nothing, widen no scope, pad nothing, and answer
 * with the rewritten prompt alone.
 */
const BALANCED_RULES = [
  '你是一个提示词优化器。请将用户的原始需求改写为更清晰、更准确、更容易执行的提示词。',
  '目标是适度补全和结构化，而不是机械改写或自由发挥。',
  '必须保持用户原意、任务对象、范围、交付物、数量、格式和限制条件。',
  '可以补全原文明确暗示的背景、目标、对象、受众、用途、步骤或输出形式，也可以补充完成任务必需但原文省略的最小信息。',
  '如果输入很短且明显模糊，可以适度明确任务目标、对象、用途、受众或输出形式，但不得凭空决定具体事实。',
  '不得新增原文没有表达或暗示的任务、工具、运行环境、依赖、安装步骤、权限要求、安全要求、隐私要求、反馈机制、验收标准、部署方案或后续工作。',
  '不得把常见最佳实践、你的建议或你认为有用的内容写成用户要求。',
  '不得把已有要求扩展成新的子任务；例如“报告问题和反馈”不能扩展为反馈规范，“运行环境”不能扩展为配置准备或安装命令。',
  '只修复歧义、补足语法、整理结构、明确已有动作，并在确有必要时做最小补全。无法确定是否属于原意时，保留原文，不要补充。',
  '如果原始需求已经具体清楚，只做轻量润色，尽量保持原文长度和信息密度。',
  '保持用户使用的语言。',
  '最终只输出改写后的提示词，不要输出解释、分析、标题、前后对比或额外说明。',
];

const MODE_RULES = Object.freeze({
  conservative: ['当前模式是保守整理：只修正语病、消除歧义、合并重复内容和整理结构。不得补充任何新信息。'],
  balanced: [],
  task: ['当前模式是完整任务化：允许补全原文明确暗示或完成任务必需的目标、背景、步骤、输出格式和验收条件，但仍不得虚构事实或新增无关任务。'],
});

export const META_PROMPT = BALANCED_RULES.join('\n');

export function getMetaPrompt(mode = 'balanced', feedback = '') {
  const rules = [...BALANCED_RULES, ...(MODE_RULES[mode] ?? MODE_RULES.balanced)];
  const normalizedFeedback = typeof feedback === 'string' ? feedback.trim() : '';
  if (normalizedFeedback !== '') {
    rules.push(`用户对当前优化的具体反馈如下。只按反馈修正，不要扩大反馈范围：\n${normalizedFeedback}`);
  }
  return rules.join('\n');
}

/**
 * Frame the user's text as one request message.
 *
 * The text is passed as a content block rather than spliced into the system
 * message, so user text can never rewrite the instruction.
 *
 * @param text - normalized user text.
 * @returns the `messages` value for `ctx.llm.stream`.
 */
export function buildMessages(text, feedback = '') {
  const normalizedFeedback = typeof feedback === 'string' ? feedback.trim() : '';
  const content = normalizedFeedback === '' ? text : `${text}\n\n用户补充的优化反馈：\n${normalizedFeedback}`;
  return [
    {
      role: 'user',
      content: [{ type: 'text', text: content }],
    },
  ];
}

/**
 * Build one complete `GenerateOptions` object for the rewrite call.
 *
 * @param input - route, text, and the policy fields the call needs.
 * @param input.provider - registered provider route.
 * @param input.model - provider-owned model id.
 * @param input.reasoningEffort - optional adapter-owned effort to inherit.
 * @param input.text - normalized user text.
 * @param input.maxOutputTokens - output budget.
 * @param input.temperature - sampling temperature.
 * @param input.signal - caller/deadline cancellation.
 * @returns the options handed to `ctx.llm.stream`.
 */
export function buildGenerateOptions(input) {
  const options = {
    provider: input.provider,
    model: input.model,
    messages: buildMessages(input.text, input.feedback),
    system: getMetaPrompt(input.mode, input.feedback),
    maxTokens: input.maxOutputTokens,
    temperature: input.temperature,
    signal: input.signal,
  };
  if (input.reasoningEffort !== undefined) options.reasoningEffort = input.reasoningEffort;
  return options;
}
