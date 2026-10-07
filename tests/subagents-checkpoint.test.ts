import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkpointProgress } from '../src/checkpoint.ts';
const request={type:'tool_execution_end',toolName:'context_compact',isError:false,result:{details:{status:'requested',resume:true}}};
test('manual checkpoint keeps the child alive across intermediate settlement',()=>{const p=checkpointProgress();p.observe(request);assert(p.waiting);p.observe({type:'agent_settled'});assert(p.waiting);assert.equal(p.observe({type:'compaction_end',reason:'manual',result:{summary:'preserved'}}),undefined);assert(!p.waiting);});
test('failed or paused checkpoint terminates without a retry loop or silent hang',()=>{for(const end of [{error:'token cap'},{aborted:true}]){const p=checkpointProgress();p.observe(request);assert(p.observe({type:'compaction_end',reason:'manual',...end}));assert(!p.waiting);}const p=checkpointProgress();p.observe({...request,result:{details:{status:'requested',resume:false}}});assert.match(p.observe({type:'compaction_end',reason:'manual',result:{}})!,/paused/);});
test('ordinary tool failures and automatic compaction do not hold settlement',()=>{const p=checkpointProgress();p.observe({...request,isError:true});assert(!p.waiting);assert.equal(p.observe({type:'compaction_end',reason:'threshold',error:'fixture'}),undefined);assert(!p.waiting);});
