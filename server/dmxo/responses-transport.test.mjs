import test from 'node:test';
import assert from 'node:assert/strict';
import { withAzureResponses, toResponsesBody } from './responses-transport.mjs';

const url='https://example.openai.azure.com/openai/v1/chat/completions';
const tool={type:'function',function:{name:'echo',description:'Echo input',parameters:{type:'object',properties:{text:{type:'string'}}}}};
const init = body => ({method:'POST',headers:{authorization:'Bearer test-key','content-type':'application/json'},body:JSON.stringify({model:'gpt-6.1-terra',messages:[{role:'user',content:'Call echo'}],...body})});
const jsonResponse=body=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
const reason={id:'rs_test',type:'reasoning',summary:[{type:'summary_text',text:'Using the requested tool.'}],encrypted_content:'opaque-test-reasoning'};
const call={id:'fc_test',type:'function_call',call_id:'call_test',name:'echo',arguments:'{"text":"hello"}',status:'completed'};
const final={id:'resp_final',model:'gpt-6.1-terra',status:'completed',output:[{id:'msg_final',type:'message',role:'assistant',content:[{type:'output_text',text:'ok'}]}],usage:{input_tokens:13,output_tokens:3,input_tokens_details:{cached_tokens:4}}};
function sse(events,{chunkSize=11}={}) {
  const text=events.map(event=>'event: '+event.type+'\r\ndata: '+JSON.stringify(event)+'\r\n\r\n').join('');
  let offset=0;
  const stream=new ReadableStream({pull(controller){if(offset>=text.length){controller.close();return;}controller.enqueue(new TextEncoder().encode(text.slice(offset,offset+=chunkSize)));}});
  return new Response(stream,{headers:{'content-type':'text/event-stream'}});
}
async function chunks(response) {
  const text=await response.text();
  return text.split('\n').filter(line=>line.startsWith('data: ')&&line!=='data: [DONE]').map(line=>JSON.parse(line.slice(6)));
}

test('unchanged providers and non-GPT6 models retain their Chat Completions transport',async()=>{
  let received;
  const transport=withAzureResponses(async(...args)=>{received=args;return jsonResponse({original:true});});
  const request=init({});
  await transport('https://api.openai.com/v1/chat/completions',request);
  assert.equal(received[0],'https://api.openai.com/v1/chat/completions');assert.equal(received[1],request);
  const older=init({model:'gpt-4.1'});await transport(url,older);assert.equal(received[1],older);
});

test('function round-trip preserves encrypted reasoning, tool identity, output and usage',async()=>{
  const requests=[];
  const transport=withAzureResponses(async(target,options)=>{
    requests.push({target,options,body:JSON.parse(options.body)});
    return jsonResponse(requests.length===1?{id:'resp_test',status:'completed',model:'gpt-6.1-terra',output:[reason,call]}:final);
  });
  const first=await (await transport(url,init({tools:[tool],tool_choice:{type:'function',function:{name:'echo'}},reasoning_effort:'low',max_completion_tokens:500}))).json();
  assert.equal(requests[0].target,'https://example.openai.azure.com/openai/v1/responses');
  assert.equal(requests[0].body.store,false);assert.equal(requests[0].body.reasoning.effort,'low');
  assert.equal(requests[0].body.tools[0].name,'echo');assert.equal(requests[0].body.tools[0].strict,false);
  assert.deepEqual(requests[0].body.tool_choice,{type:'function',name:'echo'});
  assert.equal(requests[0].body.max_output_tokens,500);
  assert.equal(first.choices[0].finish_reason,'tool_calls');
  const message=first.choices[0].message;
  const second=await (await transport(url,init({messages:[{role:'user',content:'Call echo'},message,{role:'tool',tool_call_id:'call_test',content:'{"text":"hello"}'}],tools:[tool]}))).json();
  const input=requests[1].body.input;
  assert.deepEqual(input.map(x=>x.type??x.role),['user','reasoning','function_call','function_call_output']);
  assert.equal(input[1].encrypted_content,'opaque-test-reasoning');assert.equal(input[2].id,'fc_test');
  assert.equal(input[3].call_id,'call_test');assert.equal(input[3].output,'{"text":"hello"}');
  assert.equal(second.choices[0].message.content,'ok');assert.equal(second.usage.prompt_tokens,13);assert.equal(second.usage.prompt_tokens_details.cached_tokens,4);
});

test('replay is isolated by provider credential',async()=>{
  let body;
  const transport=withAzureResponses(async(_,options)=>{body=JSON.parse(options.body);return jsonResponse(final);});
  const other=init({messages:[{role:'assistant',content:null,tool_calls:[{id:'call_test',type:'function',function:{name:'echo',arguments:'{}'}}]}]});
  other.headers.authorization='Bearer other-test-key';
  await transport(url,other);assert.equal(body.input.some(x=>x.type==='reasoning'),false);
});

test('images and structured output retain their content and schemas',()=>{
  const body=toResponsesBody({model:'gpt-6.1-terra',messages:[{role:'user',content:[{type:'text',text:'Look'},{type:'image_url',image_url:{url:'data:image/png;base64,AA==',detail:'high'}}]}],response_format:{type:'json_schema',json_schema:{name:'result',schema:{type:'object'}}}});
  assert.deepEqual(body.input[0].content,[{type:'input_text',text:'Look'},{type:'input_image',image_url:'data:image/png;base64,AA==',detail:'high'}]);
  assert.equal(body.text.format.name,'result');
});

test('streaming fragments support parallel tools and preserve terminal usage',async()=>{
  const call2={...call,id:'fc_second',call_id:'call_second',name:'echo',arguments:'{"text":"two"}'};
  const events=[
    {type:'response.created',response:{id:'resp_stream',model:'gpt-6.1-terra'}},
    {type:'response.output_item.added',output_index:0,item:{id:reason.id,type:'reasoning',summary:[]}},
    {type:'response.reasoning_summary_text.delta',delta:'Choosing tools.'},
    {type:'response.output_item.done',output_index:0,item:reason},
    {type:'response.output_item.added',output_index:1,item:{...call,arguments:''}},
    {type:'response.output_item.added',output_index:2,item:{...call2,arguments:''}},
    {type:'response.function_call_arguments.delta',output_index:1,delta:'{"text":'},
    {type:'response.function_call_arguments.delta',output_index:2,delta:'{"text":"two"}'},
    {type:'response.function_call_arguments.delta',output_index:1,delta:'"hello"}'},
    {type:'response.output_item.done',output_index:1,item:call},
    {type:'response.output_item.done',output_index:2,item:call2},
    {type:'response.completed',response:{id:'resp_stream',status:'completed',model:'gpt-6.1-terra',output:[reason,call,call2],usage:{input_tokens:15,output_tokens:8}}},
  ];
  const transport=withAzureResponses(async()=>sse(events));
  const frames=await chunks(await transport(url,init({stream:true,tools:[tool]})));
  const calls=new Map();
  for(const frame of frames)for(const item of frame.choices?.[0].delta.tool_calls??[]){const prev=calls.get(item.index)??{args:''};if(item.id)prev.id=item.id;if(item.function?.name)prev.name=item.function.name;prev.args+=item.function?.arguments??'';calls.set(item.index,prev);}
  assert.equal(calls.size,2);assert.equal(calls.get(0).args,call.arguments);assert.equal(calls.get(1).args,call2.arguments);
  assert.equal(frames.at(-1).choices[0].finish_reason,'tool_calls');assert.equal(frames.at(-1).usage.prompt_tokens,15);
  assert.equal(frames.filter(f=>f.choices?.[0].delta.reasoning_content).map(f=>f.choices[0].delta.reasoning_content).join(''),'Choosing tools.');
});

test('streaming final text does not duplicate completed output text',async()=>{
  const transport=withAzureResponses(async()=>sse([{type:'response.created',response:{id:'resp_final'}},{type:'response.output_text.delta',delta:'o'},{type:'response.output_text.delta',delta:'k'},{type:'response.completed',response:final}]));
  const frames=await chunks(await transport(url,init({stream:true})));
  assert.equal(frames.map(f=>f.choices?.[0].delta.content??'').join(''),'ok');
  assert.equal(frames.at(-1).choices[0].finish_reason,'stop');
});

test('HTTP errors retain status and retry headers without synthetic success',async()=>{
  const original=new Response(JSON.stringify({error:{message:'rate limited'}}),{status:429,headers:{'retry-after':'4'}});
  const transport=withAzureResponses(async()=>original);
  const response=await transport(url,init({stream:true}));assert.equal(response,original);assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),'4');
});

test('failed and prematurely ended streams cannot finish tool calls successfully',async()=>{
  const failed=withAzureResponses(async()=>sse([{type:'response.failed',response:{status:'failed',error:{message:'request failed'}}}]));
  const frames=await chunks(await failed(url,init({stream:true})));assert.equal(frames[0].error.message,'request failed');
  assert.equal(frames.some(x=>x.choices?.[0].finish_reason==='tool_calls'),false);
  const short=withAzureResponses(async()=>sse([{type:'response.output_item.added',output_index:0,item:{...call,arguments:''}}]));
  await assert.rejects(()=>chunksPromise(short),/ended before completion/);
});
async function chunksPromise(transport){return chunks(await transport(url,init({stream:true})));}

test('incomplete responses report length instead of executable function completion',async()=>{
  const transport=withAzureResponses(async()=>jsonResponse({status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:[call]}));
  const r=await(await transport(url,init({}))).json();assert.equal(r.choices[0].finish_reason,'length');
});

test('abort signals reach the original transport',async()=>{
  const controller=new AbortController();let signal;
  const transport=withAzureResponses(async(_,options)=>{signal=options.signal;return jsonResponse(final);});
  const request=init({});request.signal=controller.signal;await transport(url,request);assert.equal(signal,controller.signal);
});

