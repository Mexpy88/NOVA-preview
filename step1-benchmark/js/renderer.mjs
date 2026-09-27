import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

fs.mkdirSync('results',{recursive:true});
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
await page.setContent('<!doctype html><html><body style="margin:0"><div id="host"></div></body></html>');

const pixiPath=path.resolve('node_modules/pixi.js/dist/pixi.min.js');
await page.addScriptTag({path:pixiPath});

const results=await page.evaluate(async()=>{
  function segments(n){
    const a=new Float32Array(n*4);
    for(let i=0;i<n;i++){const o=i*4,x=(i*17)%1200,y=(i*31)%800;a[o]=x;a[o+1]=y;a[o+2]=(x+13)%1200;a[o+3]=(y+7)%800;}
    return a;
  }
  function med(a){const s=[...a].sort((x,y)=>x-y);return s[Math.floor(s.length/2)]}
  async function canvas(n){
    document.getElementById('host').replaceChildren();
    const c=document.createElement('canvas');c.width=1200;c.height=800;document.getElementById('host').appendChild(c);
    const ctx=c.getContext('2d');const a=segments(n);
    const builds=[];
    for(let r=0;r<8;r++){
      const t=performance.now();ctx.clearRect(0,0,1200,800);ctx.beginPath();
      for(let i=0;i<a.length;i+=4){ctx.moveTo(a[i],a[i+1]);ctx.lineTo(a[i+2],a[i+3]);}
      ctx.stroke();builds.push(performance.now()-t);
    }
    const frames=[];let tx=0;
    for(let r=0;r<120;r++){
      tx+=0.25;const t=performance.now();
      ctx.setTransform(1,0,0,1,tx%20,0);ctx.clearRect(-20,0,1240,800);ctx.beginPath();
      for(let i=0;i<a.length;i+=4){ctx.moveTo(a[i],a[i+1]);ctx.lineTo(a[i+2],a[i+3]);}
      ctx.stroke();frames.push(performance.now()-t);
    }
    return {engine:'Canvas2D',segments:n,buildMedianMs:med(builds),panFrameMedianMs:med(frames),panFrameP95Ms:[...frames].sort((a,b)=>a-b)[Math.floor(frames.length*.95)]};
  }
  async function pixi(n){
    document.getElementById('host').replaceChildren();
    const app=new PIXI.Application();
    await app.init({width:1200,height:800,antialias:false,backgroundAlpha:0,preference:'webgl'});
    document.getElementById('host').appendChild(app.canvas);
    const a=segments(n);const builds=[];
    let g;
    for(let r=0;r<8;r++){
      if(g){app.stage.removeChild(g);g.destroy();}
      g=new PIXI.Graphics();const t=performance.now();
      for(let i=0;i<a.length;i+=4){g.moveTo(a[i],a[i+1]).lineTo(a[i+2],a[i+3]);}
      g.stroke({width:1,color:0x111111});app.stage.addChild(g);app.renderer.render(app.stage);
      builds.push(performance.now()-t);
    }
    const frames=[];
    for(let r=0;r<120;r++){
      const t=performance.now();app.stage.x=(r*.25)%20;app.renderer.render(app.stage);frames.push(performance.now()-t);
    }
    const gl=app.canvas.getContext('webgl2')||app.canvas.getContext('webgl');
    let gpu={};
    if(gl){
      const ext=gl.getExtension('WEBGL_debug_renderer_info');
      gpu={vendor:ext?gl.getParameter(ext.UNMASKED_VENDOR_WEBGL):gl.getParameter(gl.VENDOR),renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)};
    }
    const out={engine:'PixiJS',segments:n,buildMedianMs:med(builds),panFrameMedianMs:med(frames),panFrameP95Ms:[...frames].sort((a,b)=>a-b)[Math.floor(frames.length*.95)],gpu};
    if(g)g.destroy();app.destroy(true);
    return out;
  }
  const all=[];
  for(const n of [1000,10000,100000])all.push(await canvas(n));
  for(const n of [1000,10000,100000])all.push(await pixi(n));
  return {userAgent:navigator.userAgent,hardwareConcurrency:navigator.hardwareConcurrency,devicePixelRatio:devicePixelRatio,results:all};
});

const output={generatedAt:new Date().toISOString(),environment:'GitHub Actions headless Chromium; software/GPU details recorded; not Android',...results};
fs.writeFileSync('results/renderer-results.json',JSON.stringify(output,null,2));
console.log(JSON.stringify(output,null,2));
await browser.close();
