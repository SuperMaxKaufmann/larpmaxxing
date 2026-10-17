// Only a terminal completed event authorizes saving output. Partial output,
// interrupted streams and post-admission usage errors never become drafts.
export async function readResponseStream(response, signal) {
  if(!response.body?.getReader)throw Error('invalid stream');
  const reader=response.body.getReader(),decoder=new TextDecoder();
  let pending='',bytes=0;
  const abort=()=>{reader.cancel().catch(()=>{});};
  signal.addEventListener('abort',abort,{once:true});
  try {
    while(true) {
      signal.throwIfAborted();
      const {done,value}=await reader.read();
      signal.throwIfAborted();
      if(done)break;
      bytes+=value.byteLength;
      if(bytes>4_000_000)throw Error('stream too large');
      pending+=decoder.decode(value,{stream:true});
      let match;
      while((match=/\r?\n\r?\n/.exec(pending))) {
        const block=pending.slice(0,match.index);pending=pending.slice(match.index+match[0].length);
        const data=block.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
        if(!data||data==='[DONE]')continue;
        const event=JSON.parse(data);
        if(['response.completed','response.failed','response.incomplete'].includes(event.type)) {
          if(!event.response||typeof event.response!=='object')throw Error('invalid terminal event');
          return {...event.response,status:event.type.slice('response.'.length)};
        }
        if(event.type==='error')return {status:'failed',error:event.error||event};
      }
    }
    throw Error('stream ended before completion');
  } finally {signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
