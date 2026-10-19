/** Real CDP inputs; never assign details.open or synthesize DOM clicks. */
export function disclosureKeyEvents(key){
 const definition=key==='Enter'?{key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'}:key==='Space'?{key:' ',code:'Space',windowsVirtualKeyCode:32,text:' '}:null;
 if(!definition)throw new Error('Unsupported disclosure key: '+key);
 const {text,...identity}=definition;
 return [{type:'keyDown',...identity,text,unmodifiedText:text},{type:'keyUp',...identity}];
}
/** Executed in Chromium; wait for stable viewport geometry and a real hit target. */
export async function prepareDisclosureTarget(index,doc=globalThis.document,view=globalThis.window,timeoutMs=3000){
 const summary=doc.querySelectorAll('.product-accordion')[index]?.firstElementChild;
 if(!summary||summary.tagName!=='SUMMARY')throw new Error('Missing native summary: '+index);
 // "auto" inherits the site's smooth scrolling. Two animation frames cannot finish it.
 summary.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
 summary.focus({preventScroll:true});
 const deadline=Date.now()+timeoutMs;
 let previous=null,stable=0,last;
 const describe=node=>node?{tag:node.tagName,id:node.id,className:node.className}:null;
 while(Date.now()<deadline){
  await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error('Disclosure animation frame timeout: '+JSON.stringify(last))),Math.max(1,deadline-Date.now()));
   view.requestAnimationFrame(()=>{clearTimeout(timer);resolve();});
  });
  const rect=summary.getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2;
  const hit=doc.elementFromPoint(x,y),vv=view.visualViewport;
  const geometry=[rect.left,rect.top,rect.width,rect.height,view.scrollX,view.scrollY,vv?.offsetLeft??0,vv?.offsetTop??0,vv?.width??view.innerWidth,vv?.height??view.innerHeight];
  const visible=rect.width>0&&rect.height>0&&rect.left>=0&&rect.top>=0&&rect.right<=view.innerWidth&&rect.bottom<=view.innerHeight;
  const hitTarget=hit===summary||summary.contains(hit);
  stable=previous&&geometry.every((value,i)=>Math.abs(value-previous[i])<.25)?stable+1:0;
  previous=geometry;
  last={index,focused:doc.activeElement===summary,x,y,rect:{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height},scroll:{x:view.scrollX,y:view.scrollY},viewport:{width:view.innerWidth,height:view.innerHeight,visual:vv?{offsetLeft:vv.offsetLeft,offsetTop:vv.offsetTop,width:vv.width,height:vv.height}:null},visible,hitTarget,hit:describe(hit),stack:doc.elementsFromPoint(x,y).slice(0,6).map(describe),open:summary.parentElement.open,stableFrames:stable};
  if(stable>=3&&visible&&hitTarget&&last.focused)return last;
 }
 throw new Error('Disclosure target not stable, visible or hittable: '+JSON.stringify(last));
}
export async function exerciseShopDisclosures(send){
 const evaluate=async expression=>{
  const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
  if(result.exceptionDetails)throw new Error('Disclosure evaluation failed: '+JSON.stringify(result.exceptionDetails));
  return result.result.value;
 };
 const structure=await evaluate(`(()=>{const items=[...document.querySelectorAll('.product-accordion')],ids=[...document.querySelectorAll('[id]')].map(x=>x.id);window.disclosureEvents=[];for(const type of ['keydown','keypress','keyup','pointerdown','pointerup','mousedown','mouseup','click','dblclick','toggle'])document.addEventListener(type,event=>{window.disclosureEvents.push({type,key:event.key,trusted:event.isTrusted,tag:event.target.tagName,id:event.target.id,className:event.target.className,index:[...document.querySelectorAll('.product-accordion')].indexOf(event.target.closest?.('.product-accordion')),x:event.clientX,y:event.clientY,buttons:event.buttons,detail:event.detail,scrollY:window.scrollY,focus:document.activeElement?.tagName});if(window.disclosureEvents.length>200)window.disclosureEvents.shift()},true);return {states:items.map(x=>x.open),products:items.map(x=>[...document.querySelectorAll('.shop-column')].indexOf(x.closest('.shop-column'))),native:items.every(x=>x.tagName==='DETAILS'&&x.firstElementChild?.tagName==='SUMMARY'),unique:new Set(ids).size===ids.length,aria:[...document.querySelectorAll('[aria-controls],[aria-labelledby],[aria-describedby]')].every(x=>['aria-controls','aria-labelledby','aria-describedby'].every(a=>(x.getAttribute(a)||'').split(/\\s+/).filter(Boolean).every(id=>ids.filter(value=>value===id).length===1)))}})()`);
 if(!structure.states.length||!structure.native||!structure.unique||!structure.aria||structure.states.some(Boolean)||structure.products.some(x=>x<0))throw new Error('Invalid initial disclosure structure: '+JSON.stringify(structure));
 const expected=[...structure.states];let actions=0,lastTarget=null;
 const assertState=async stage=>{
  const actual=await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>resolve({states:[...document.querySelectorAll('.product-accordion')].map(x=>x.open),focus:document.activeElement?.tagName,events:window.disclosureEvents.slice(-12)})))`);
  if(stage?.input==='mouse'){
   const mouse=actual.events.filter(event=>['mousedown','mouseup','click'].includes(event.type));
   if(['mousedown','mouseup','click'].some(type=>mouse.filter(event=>event.type===type).length!==1)||mouse.some(event=>event.index!==stage.index||!event.trusted||event.detail!==1)||actual.events.some(event=>event.type==='dblclick'))throw new Error('Mouse event target or single-click sequence failed: '+JSON.stringify({stage,actual,lastTarget}));
  }
  if(JSON.stringify(actual.states)!==JSON.stringify(expected))throw new Error('Disclosure state mismatch: '+JSON.stringify({stage,expected,actual,lastTarget}));
 };
 const activate=async(index,input)=>{
  const target=await evaluate(`(${prepareDisclosureTarget.toString()})(${index})`);
  lastTarget=target;
  if(!target.focused)throw new Error('Disclosure summary focus failed: '+JSON.stringify({index,input,target}));
  await evaluate('window.disclosureEvents=[]');
  if(input==='mouse'){
   await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:target.x,y:target.y});
   const hit=await evaluate(`(()=>{const summary=document.querySelectorAll('.product-accordion')[${index}].firstElementChild,box=summary.getBoundingClientRect(),hit=document.elementFromPoint(${target.x},${target.y});return {valid:(hit===summary||summary.contains(hit))&&Math.abs(box.left+box.width/2-${target.x})<.25&&Math.abs(box.top+box.height/2-${target.y})<.25,hit:hit?.tagName,scrollY:window.scrollY}})()`);
   if(!hit.valid)throw new Error('Disclosure moved or was intercepted before mouse press: '+JSON.stringify({index,target,hit}));
   await send('Input.dispatchMouseEvent',{type:'mousePressed',x:target.x,y:target.y,button:'left',buttons:1,clickCount:1});
   await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:target.x,y:target.y,button:'left',buttons:0,clickCount:1});
  }else for(const event of disclosureKeyEvents(input))await send('Input.dispatchKeyEvent',event);
  expected[index]=!expected[index];actions++;
  await assertState({index,input,open:expected[index]});
 };
 // Every Matcha and accessory row must open and close with all three inputs.
 for(let index=0;index<expected.length;index++)for(const input of ['Enter','Space','mouse']){await activate(index,input);await activate(index,input);}
 // Keep A open while opening B, then keep B open while closing A.
 const other=structure.products.findIndex(product=>product!==structure.products[0]);
 if(other>=0){await activate(0,'Enter');await activate(other,'Space');await activate(0,'mouse');await activate(other,'Enter');}
 await assertState('all disclosures closed after interaction');
 return {disclosures:expected.length,actions,crossProductIndependence:other>=0?'PASS':'not applicable: one product'};
}
