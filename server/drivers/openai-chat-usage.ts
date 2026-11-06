export interface OpenAIUsage {
  input: number;
  output: number;
  cachedInput?: number;
}

export interface ChatCompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  cost?: number;
}

export function usageFrom(usage: ChatCompletionUsage | undefined): OpenAIUsage | null {
  if (!usage) return null;
  const cachedInput = usage.prompt_tokens_details?.cached_tokens;
  return {
    input: usage.prompt_tokens ?? 0,
    output: usage.completion_tokens ?? 0,
    ...(typeof cachedInput === "number" && Number.isFinite(cachedInput) && cachedInput >= 0 ? { cachedInput } : {}),
  };
}

export class ChatUsageTotals {
  readonly total: OpenAIUsage = { input: 0, output: 0 };
  available = false;
  private completeCachedUsage = true;

  add(usage: OpenAIUsage | null): void {
    if (usage?.cachedInput === undefined) {
      this.completeCachedUsage = false;
      delete this.total.cachedInput;
    } else if (this.completeCachedUsage) {
      this.total.cachedInput = (this.total.cachedInput ?? 0) + usage.cachedInput;
    }
    if (usage) {
      this.total.input += usage.input;
      this.total.output += usage.output;
      this.available = true;
    }
  }
}
