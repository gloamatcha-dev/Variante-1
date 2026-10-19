/** Browser-side readiness: lazy images must enter the viewport before decoding. */
export async function inspectShopGrid(doc=globalThis.document,view=globalThis.window,timeoutMs=45000){
 const deadline=Date.now()+timeoutMs;
 const stage=message=>{doc.documentElement.dataset.gridCheckStage=message;console.info('grid-check: '+message);};
 const bounded=async(promise,label)=>{
  let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Grid readiness timeout: '+label)),Math.max(1,deadline-Date.now()));})]);}finally{clearTimeout(timer);}
 };
 const frame=()=>bounded(new Promise(resolve=>view.requestAnimationFrame(resolve)),'animation frame');
 stage('fonts');await bounded(doc.fonts.ready,'fonts');
 const grid=doc.querySelector('.shop-products');if(!grid)throw new Error('Grid missing after DOMContentLoaded');
 const images=[...doc.images];
 for(const [index,image]of images.entries()){
  stage('image '+(index+1)+'/'+images.length);
  // Do not change loading="lazy" or swallow decode failures. Exercise real lazy loading.
  image.scrollIntoView({block:'center'});await frame();
  await bounded(image.decode(),'image '+(index+1)+' '+image.getAttribute('src'));
  if(!image.complete||image.naturalWidth<=0)throw new Error('Image not loaded: '+image.getAttribute('src'));
 }
 stage('layout');view.scrollTo(0,0);await frame();await frame();
 const image=doc.querySelector('.shop-product-visual');if(!image)throw new Error('Image frame missing');
 const bounds=image.getBoundingClientRect();
 let single=null;
 if(grid.children.length===1){
  const row=doc.querySelector('.shop-product-row').getBoundingClientRect(),info=doc.querySelector('.shop-product-info').getBoundingClientRect();
  single={display:view.getComputedStyle(grid).display,width:row.width,left:row.left,right:row.right,imageWidth:bounds.width,imageLeft:bounds.left,imageTop:bounds.top,imageRight:bounds.right,imageBottom:bounds.bottom,infoWidth:info.width,infoLeft:info.left,infoRight:info.right,infoTop:info.top};
 }
 let compact=null;
 if(grid.children.length<=2){
  const frames=[...doc.querySelectorAll('.shop-product-visual')];
  compact={heights:frames.map(frame=>frame.getBoundingClientRect().height),
   contain:images.every(image=>view.getComputedStyle(image).objectFit==='contain'),
   backgrounds:frames.map(frame=>view.getComputedStyle(frame).backgroundColor),cream:view.getComputedStyle(doc.body).backgroundColor,
   disclosureGap:parseFloat(view.getComputedStyle(grid).paddingBottom)};
 }
 const style=view.getComputedStyle(grid);
 // A block can retain a computed grid-template declaration, but has no grid tracks.
 const isGrid=style.display==='grid'||style.display==='inline-grid';
 return {columns:isGrid?style.gridTemplateColumns.trim().split(/\s+/).length:null,gridDisplay:style.display,gridTemplateColumns:style.gridTemplateColumns,cards:grid.children.length,
  overflow:doc.documentElement.scrollWidth>view.innerWidth,ratio:bounds.width/bounds.height,
  images:images.length>0&&images.every(image=>image.complete&&image.naturalWidth>0),
  lazy:images.every(image=>image.loading==='lazy'),single,compact};
}

/** Validate the editorial layout by measured geometry, never dormant grid CSS. */
export function isSingleProductLayout(single,viewportWidth){
 if(!single||single.display!=='block')return false;
 const values=['width','left','right','imageWidth','imageLeft','imageTop','imageRight','imageBottom','infoWidth','infoLeft','infoRight','infoTop'];
 if(values.some(key=>!Number.isFinite(single[key]))||single.width<viewportWidth*.75||single.imageWidth<=0||single.infoWidth<=0)return false;
 if(single.left<-1||single.right>viewportWidth+1||single.imageLeft<single.left-1||single.imageRight>single.right+1||single.infoLeft<single.left-1||single.infoRight>single.right+1)return false;
 if(viewportWidth<900)return single.infoTop>=single.imageBottom-1&&Math.abs(single.imageLeft-single.infoLeft)<=1&&Math.abs(single.imageWidth-single.infoWidth)<=1;
 return single.infoLeft>=single.imageRight-1&&Math.abs(single.infoTop-single.imageTop)<=1&&single.imageWidth/single.width>=.45&&single.imageWidth/single.width<=.55;
}
