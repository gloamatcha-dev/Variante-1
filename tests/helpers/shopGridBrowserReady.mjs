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
 return {columns:view.getComputedStyle(grid).gridTemplateColumns.split(' ').length,cards:grid.children.length,
  overflow:doc.documentElement.scrollWidth>view.innerWidth,ratio:bounds.width/bounds.height,
  images:images.length>0&&images.every(image=>image.complete&&image.naturalWidth>0),
  lazy:images.every(image=>image.loading==='lazy')};
}
