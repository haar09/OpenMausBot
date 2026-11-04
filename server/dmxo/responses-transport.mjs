import { createHash } from 'node:crypto';

const replay = new Map();
const MAX_REPLAY_CALLS = 1024;
const MAX_FRAME = 2_000_000;
const encoder = new TextEncoder();

function isResponsesTarget(url, model) {
  let target;
  try { target = new URL(url); } catch { return false; }
  return target.protocol === 'https:' &&
    (target.hostname.endsWith('.openai.azure.com') || target.hostname.endsWith('.services.ai.azure.com')) &&
    target.pathname.endsWith('/chat/completions') && /^gpt-6(?:[.-]|$)/i.test(model ?? '');
}

function scopeFor(url, init, model) {
  const headers = new Headers(init.headers);
  return createHash('sha256').update(url).update('\0').update(model)
    .update('\0').update(headers.get('authorization') ?? headers.get('api-key') ?? '').digest('hex');
}

function inputContent(content) {
  if (!Array.isArray(content)) return content ?? '';
  return content.map(part => {
    if (part.type === 'text') return { type: 'input_text', text: part.text };
    if (part.type === 'image_url') return {
      type: 'input_image', image_url: part.image_url.url,
      ...(part.image_url.detail ? { detail: part.image_url.detail } : {}),
    };
    throw new Error(`Unsupported Responses input content: ${part.type}`);
  });
}

function inputMessages(messages, scope) {
  const input = [];
  const reasoningIds = new Set();
  for (const message of messages ?? []) {
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: inputContent(message.content) });
      continue;
    }
    for (const call of message.tool_calls ?? []) {
      const cached = replay.get(scope + ':' + call.id);
      for (const item of cached?.reasoning ?? []) {
        const key = item.id ?? JSON.stringify(item);
        if (!reasoningIds.has(key)) { input.push(item); reasoningIds.add(key); }
      }
    }
    if (message.content && (!Array.isArray(message.content) || message.content.length)) {
      input.push({ role: message.role, content: inputContent(message.content) });
    }
    for (const call of message.tool_calls ?? []) {
      const cached = replay.get(scope + ':' + call.id);
      input.push({
        type: 'function_call', ...(cached?.itemId ? { id: cached.itemId } : {}),
        call_id: call.id, name: call.function.name, arguments: call.function.arguments,
      });
    }
  }
  return input;
}

export function toResponsesBody(body, scope = '') {
  const result = {
    model: body.model,
    input: inputMessages(body.messages, scope),
    stream: body.stream === true,
    store: false,
    include: ['reasoning.encrypted_content'],
  };
  for (const key of ['temperature', 'top_p', 'parallel_tool_calls', 'metadata', 'service_tier', 'truncation', 'user']) {
    if (body[key] !== undefined) result[key] = body[key];
  }
  const outputLimit = body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens;
  if (outputLimit !== undefined) result.max_output_tokens = outputLimit;
  if (body.reasoning || body.reasoning_effort !== undefined) result.reasoning = {
    ...body.reasoning, ...(body.reasoning_effort !== undefined ? { effort: body.reasoning_effort } : {}),
  };
  if (body.tools?.length) result.tools = body.tools.map(tool => {
    if (tool.type !== 'function' || !tool.function?.name) throw new Error('Only function tools are supported by this Responses transport');
    return {
      type: 'function', ...tool.function,
      // Responses defaults strict schemas differently from Chat Completions.
      strict: tool.function.strict ?? false,
    };
  });
  if (body.tool_choice !== undefined) result.tool_choice = typeof body.tool_choice === 'object'
    ? { type: 'function', name: body.tool_choice.function?.name ?? body.tool_choice.name }
    : body.tool_choice;
  if (body.response_format?.type === 'json_schema') {
    result.text = { format: { type: 'json_schema', ...body.response_format.json_schema } };
  } else if (body.response_format?.type === 'json_object') {
    result.text = { format: { type: 'json_object' } };
  }
  return result;
}

function remember(output, scope) {
  // Stateless Responses reasoning items must accompany the function calls on subsequent rounds.
  const reasoning = output.filter(item => item.type === 'reasoning');
  for (const item of output) {
    if (item.type !== 'function_call' || !item.call_id) continue;
    const key = scope + ':' + item.call_id;
    replay.delete(key);
    replay.set(key, { reasoning, itemId: item.id });
  }
  while (replay.size > MAX_REPLAY_CALLS) replay.delete(replay.keys().next().value);
}

function usage(value) {
  if (!value) return undefined;
  return {
    prompt_tokens: value.input_tokens ?? 0,
    completion_tokens: value.output_tokens ?? 0,
    total_tokens: value.total_tokens ?? (value.input_tokens ?? 0) + (value.output_tokens ?? 0),
    ...(value.input_tokens_details ? { prompt_tokens_details: { cached_tokens: value.input_tokens_details.cached_tokens ?? 0 } } : {}),
  };
}

function toolCall(item) {
  return { id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments ?? '' } };
}

function finishReason(response) {
  if (response.status === 'incomplete') return response.incomplete_details?.reason === 'max_output_tokens' ? 'length' : 'content_filter';
  return response.output?.some(item => item.type === 'function_call') ? 'tool_calls' : 'stop';
}

function responseError(response) {
  if (response.status === 'failed' || response.error) return response.error ?? { message: 'Responses request failed' };
  if (response.status === 'cancelled') return { message: 'Responses request was cancelled' };
  return null;
}

function fromResponse(response, scope) {
  const error = responseError(response);
  if (error) return { error };
  const output = response.output ?? [];
  remember(output, scope);
  const parts = output.filter(item => item.type === 'message').flatMap(item => item.content ?? []);
  const text = parts.map(part => part.text ?? part.refusal ?? '').join('');
  const reasoning = output.filter(item => item.type === 'reasoning').flatMap(item => item.summary ?? [])
    .map(part => part.text ?? '').join('');
  const calls = output.filter(item => item.type === 'function_call').map(toolCall);
  return {
    id: response.id, object: 'chat.completion', model: response.model,
    choices: [{ index: 0, message: { role: 'assistant', content: text || null,
      ...(reasoning ? { reasoning_content: reasoning } : {}), ...(calls.length ? { tool_calls: calls } : {}) },
      finish_reason: finishReason(response) }],
    usage: usage(response.usage),
  };
}

function responseHeaders(source, streaming) {
  const headers = new Headers(source.headers);
  for (const name of ['content-length', 'content-encoding', 'transfer-encoding']) headers.delete(name);
  headers.set('content-type', streaming ? 'text/event-stream; charset=utf-8' : 'application/json');
  headers.set('cache-control', 'no-store');
  return headers;
}

function streamResponse(source, scope) {
  const reader = source.body.getReader();
  let cancelled = false;
  const stream = new ReadableStream({
    async start(controller) {
      const decoder = new TextDecoder();
      let buffer = '', terminal = false;
      let responseId, model;
      const items = new Map(), calls = new Map();
      let sawText = false, sawReasoning = false;
      const emit = data => { if (!cancelled) controller.enqueue(encoder.encode('data: ' + JSON.stringify(data) + '\n\n')); };
      const delta = value => emit({ id: responseId, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: value, finish_reason: null }] });
      const callState = (index, item) => {
        let state = calls.get(index);
        if (!state) {
          if (!item?.call_id || !item?.name) throw new Error('Responses function call has no identity');
          state = { index: calls.size, id: item.call_id, name: item.name, args: '' };
          calls.set(index, state);
          delta({ tool_calls: [{ index: state.index, ...toolCall({ ...item, arguments: '' }) }] });
        }
        if (item?.call_id && (state.id !== item.call_id || state.name !== item.name)) throw new Error('Responses function identity changed while streaming');
        return state;
      };
      const finishCall = (index, item) => {
        const state = callState(index, item);
        const full = item.arguments ?? '';
        if (!full.startsWith(state.args)) throw new Error('Responses function arguments changed while streaming');
        const tail = full.slice(state.args.length);
        if (tail) delta({ tool_calls: [{ index: state.index, function: { arguments: tail } }] });
        state.args = full;
      };
      const accept = event => {
        if (terminal) return;
        if (event.type === 'response.created' || event.type === 'response.in_progress') {
          responseId = event.response?.id ?? responseId; model = event.response?.model ?? model;
        } else if (event.type === 'response.output_item.added') {
          items.set(event.output_index, event.item);
          if (event.item?.type === 'function_call') callState(event.output_index, event.item);
        } else if (event.type === 'response.function_call_arguments.delta') {
          const state = callState(event.output_index, items.get(event.output_index));
          state.args += event.delta ?? '';
          delta({ tool_calls: [{ index: state.index, function: { arguments: event.delta ?? '' } }] });
        } else if (event.type === 'response.output_item.done') {
          items.set(event.output_index, event.item);
          if (event.item?.type === 'function_call') finishCall(event.output_index, event.item);
        } else if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
          sawText = true; delta({ content: event.delta ?? '' });
        } else if (event.type === 'response.reasoning_summary_text.delta' || event.type === 'response.reasoning_summary.delta') {
          sawReasoning = true; delta({ reasoning_content: event.delta ?? '' });
        } else if (event.type === 'error') {
          emit({ error: event.error ?? { message: event.message ?? 'Responses streaming error' } }); terminal = true;
        } else if (['response.completed', 'response.incomplete', 'response.failed', 'response.cancelled'].includes(event.type)) {
          const response = event.response ?? {};
          responseId = response.id ?? responseId; model = response.model ?? model;
          const error = responseError(response);
          if (error) { emit({ error }); terminal = true; return; }
          const output = response.output?.length ? response.output : [...items.entries()].sort((a,b)=>a[0]-b[0]).map(([,value])=>value);
          response.output = output;
          output.forEach((item,index) => { if (item.type === 'function_call') finishCall(index, item); });
          const converted = fromResponse(response, scope);
          const message = converted.choices[0].message;
          if (!sawText && message.content) delta({ content: message.content });
          if (!sawReasoning && message.reasoning_content) delta({ reasoning_content: message.reasoning_content });
          emit({ id: responseId, object: 'chat.completion.chunk', model,
            choices: [{ index: 0, delta: {}, finish_reason: finishReason(response) }], usage: converted.usage });
          terminal = true;
        }
        if (!terminal && !cancelled) controller.enqueue(encoder.encode(': response-event\n\n'));
      };
      const consume = frame => {
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') return;
        accept(JSON.parse(data));
      };
      try {
        while (!cancelled) {
          const { done, value } = await reader.read();
          buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
          if (buffer.length > MAX_FRAME) throw new Error('Responses stream frame exceeded the size limit');
          let split;
          while ((split = /\r?\n\r?\n/.exec(buffer))) {
            const frame = buffer.slice(0, split.index);
            buffer = buffer.slice(split.index + split[0].length);
            consume(frame);
            if (terminal) break;
          }
          if (terminal) break;
          if (done) {
            if (buffer.trim()) consume(buffer);
            if (!terminal) throw new Error('Responses stream ended before completion');
            break;
          }
        }
        if (!cancelled) { controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); }
      } catch (error) {
        if (!cancelled) controller.error(error);
      } finally { await reader.cancel().catch(() => {}); }
    },
    async cancel(reason) { cancelled = true; await reader.cancel(reason).catch(() => {}); },
  });
  return new Response(stream, { status: source.status, headers: responseHeaders(source, true) });
}

export function withAzureResponses(originalFetch) {
  return async function azureResponsesFetch(url, init = {}) {
    let body;
    if (typeof init.body === 'string') {
      try { body = JSON.parse(init.body); } catch {}
    }
    if (!body || !isResponsesTarget(url, body.model)) return originalFetch(url, init);
    const scope = scopeFor(url, init, body.model);
    const request = toResponsesBody(body, scope);
    const target = new URL(url);
    target.pathname = target.pathname.replace(/\/chat\/completions$/, '/responses');
    const response = await originalFetch(target.href, { ...init, body: JSON.stringify(request) });
    if (!response.ok) return response;
    if (request.stream && response.headers.get('content-type')?.includes('text/event-stream')) {
      if (!response.body) throw new Error('Responses endpoint returned no stream body');
      return streamResponse(response, scope);
    }
    const converted = fromResponse(await response.json(), scope);
    return new Response(JSON.stringify(converted), { status: response.status, headers: responseHeaders(response, false) });
  };
}
