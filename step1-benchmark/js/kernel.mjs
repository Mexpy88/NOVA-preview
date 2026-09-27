import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  union, intersect, difference, inflatePaths,
  FillRule, JoinType, EndType
} from 'clipper2-ts';
import Module from 'manifold-3d';
import DxfParser from 'dxf-parser';
import { DxfWriter, point3d, Units, Colors } from '@tarikjabiri/dxf';

fs.mkdirSync('results', {recursive:true});

function median(xs){const a=[...xs].sort((x,y)=>x-y);return a[Math.floor(a.length/2)];}
function signedArea(path){
  let a=0;
  for(let i=0,j=path.length-1;i<path.length;j=i++){
    a += path[j].x*path[i].y-path[i].x*path[j].y;
  }
  return a/2;
}
function totalArea(paths){return Math.abs(paths.reduce((s,p)=>s+signedArea(p),0));}
function rect(x,y,w,h){return [{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}];}
function overlapArea(a,b){
  const x=Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x));
  const y=Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));
  return x*y;
}

async function benchClipper(){
  const SCALE=10000;
  let seed=0x12345678;
  function rnd(){seed=(1664525*seed+1013904223)>>>0;return seed/2**32;}
  let failures=[];
  const times=[];
  for(let i=0;i<5000;i++){
    const A={x:Math.round((rnd()*2000-1000)*SCALE),y:Math.round((rnd()*2000-1000)*SCALE),
      w:Math.round((1+rnd()*400)*SCALE),h:Math.round((1+rnd()*400)*SCALE)};
    const B={x:Math.round((rnd()*2000-1000)*SCALE),y:Math.round((rnd()*2000-1000)*SCALE),
      w:Math.round((1+rnd()*400)*SCALE),h:Math.round((1+rnd()*400)*SCALE)};
    const pa=[rect(A.x,A.y,A.w,A.h)], pb=[rect(B.x,B.y,B.w,B.h)];
    const t0=performance.now();
    const u=union(pa,pb,FillRule.NonZero);
    const inter=intersect(pa,pb,FillRule.NonZero);
    const d=difference(pa,pb,FillRule.NonZero);
    times.push(performance.now()-t0);
    const oi=overlapArea(A,B);
    const expectedU=A.w*A.h+B.w*B.h-oi;
    const expectedD=A.w*A.h-oi;
    const errU=Math.abs(totalArea(u)-expectedU)/Math.max(1,expectedU);
    const errI=Math.abs(totalArea(inter)-oi)/Math.max(1,oi);
    const errD=Math.abs(totalArea(d)-expectedD)/Math.max(1,expectedD);
    if(errU>1e-9 || errI>1e-9 || errD>1e-9){
      failures.push({i,errU,errI,errD});
      if(failures.length>=5) break;
    }
  }

  const p=[[...rect(0,0,100*SCALE,80*SCALE)]];
  const delta=Math.round(0.12*SCALE);
  const off=inflatePaths(p,delta,JoinType.Miter,EndType.Polygon);
  const expected=(100+0.24)*(80+0.24)*SCALE*SCALE;
  const offsetRelErr=Math.abs(totalArea(off)-expected)/expected;

  let rangePass=false, rangeError=null;
  try{
    const big=2_000_000_000 * SCALE; // 2e13: safe integer, intentionally large.
    const q=[[...rect(big,big,100*SCALE,100*SCALE)]];
    const z=union(q,[],FillRule.NonZero);
    rangePass=z.length===1 && Number.isSafeInteger(big);
  }catch(e){rangeError=String(e);}

  return {
    candidate:'clipper2-ts',
    version:'2.0.1-18',
    scaleUnitsPerMm:SCALE,
    randomizedRectangleCases:5000,
    failures,
    pass:failures.length===0 && offsetRelErr<1e-9,
    medianBooleanTripletMs:median(times),
    p95BooleanTripletMs:[...times].sort((a,b)=>a-b)[Math.floor(times.length*.95)],
    miterOffset012mmRelativeAreaError:offsetRelErr,
    largeSafeIntegerCase:{pass:rangePass,error:rangeError},
    triangulationUsed:false
  };
}

async function benchManifold(){
  const init0=performance.now();
  const wasm=await Module();
  wasm.setup();
  const initMs=performance.now()-init0;
  const {Manifold}=wasm;

  function batch(count){
    const cubes=[];
    const t0=performance.now();
    for(let i=0;i<count;i++){
      cubes.push(Manifold.cube([10,10,3]).translate([(i%25)*8,Math.floor(i/25)*8,0]));
    }
    const u=Manifold.union(cubes);
    const mesh=u.getMesh();
    const elapsed=performance.now()-t0;
    const triCount=mesh.triVerts.length/3;
    u.delete();
    for(const c of cubes)c.delete();
    return {elapsedMs:elapsed,triCount};
  }

  function booleanBatch(n=100){
    const t0=performance.now();
    for(let i=0;i<n;i++){
      const a=Manifold.cube([10,10,3]);
      const b=Manifold.cube([6,6,5]).translate([2,2,-1]);
      const d=a.subtract(b);
      d.getMesh();
      d.delete(); b.delete(); a.delete();
    }
    return performance.now()-t0;
  }

  const hundred=batch(100);
  const fiveHundred=batch(500);

  // Warm the allocator before judging lifecycle stability.
  for(let i=0;i<3;i++){
    booleanBatch(100);
    if(global.gc) global.gc();
  }
  const baselineRss=process.memoryUsage().rss;

  const rssSeries=[];
  const loopTimes=[];
  for(let batchNo=0;batchNo<20;batchNo++){
    loopTimes.push(booleanBatch(100));
    if(global.gc) global.gc();
    rssSeries.push(process.memoryUsage().rss);
  }

  const tail=rssSeries.slice(-5);
  const tailSpread=Math.max(...tail)-Math.min(...tail);
  const finalRss=rssSeries.at(-1);
  const growthFromBaseline=finalRss-baselineRss;
  // Conservative CI guardrail: allocator may retain pages, but repeated explicit
  // delete() should stabilize rather than grow without bound.
  const maxTailSpreadBytes=32*1024*1024;
  const maxGrowthFromWarmBaselineBytes=96*1024*1024;
  const lifecyclePass=
    tailSpread<=maxTailSpreadBytes &&
    growthFromBaseline<=maxGrowthFromWarmBaselineBytes;

  return {
    candidate:'manifold-3d',version:'3.5.4',
    wasmInitMs:initMs,
    union100:hundred,union500:fiveHundred,
    booleanLoopOperations:2000,
    median100BooleanBatchMs:median(loopTimes),
    processRssBytes:{
      warmBaseline:baselineRss,
      final:finalRss,
      growthFromWarmBaseline:growthFromBaseline,
      tailSpread,
      series:rssSeries,
      maxTailSpreadBytes,
      maxGrowthFromWarmBaselineBytes
    },
    lifecyclePass,
    lifecycleMethod:'explicit Manifold.delete() + --expose-gc + RSS stabilization after 3 warmup batches',
    note:'Manifold WASM objects require explicit delete(); Emscripten memory is not expected to shrink to its initial size.'
  };
}
async function benchDxf(){
  const dxf=new DxfWriter();
  dxf.setUnits(Units.Millimeters);
  dxf.addLayer('CUT',Colors.Red);
  dxf.addLayer('SCORE',Colors.Blue);
  dxf.setCurrentLayerName('CUT');
  dxf.addLine(point3d(0,0),point3d(100,0));
  dxf.addCircle(point3d(30,30),10);
  dxf.addArc(point3d(70,30),12,30,280);
  dxf.addEllipse(point3d(50,70),point3d(20,0),0.5,0,Math.PI*2);
  dxf.addSpline({
    controlPoints:[point3d(0,90),point3d(30,110),point3d(60,80),point3d(100,100)],
    degree:3
  });
  dxf.setCurrentLayerName('SCORE');
  dxf.addLine(point3d(0,10),point3d(100,10));
  const raw=dxf.stringify();
  fs.writeFileSync('results/js-roundtrip.dxf',raw);

  const parser=new DxfParser();
  const parsed=parser.parseSync(raw);
  const counts={}; const layers={};
  for(const e of parsed.entities??[]){
    counts[e.type]=(counts[e.type]??0)+1;
    layers[e.layer]=(layers[e.layer]??0)+1;
  }
  const required=['LINE','CIRCLE','ARC','ELLIPSE','SPLINE'];
  const units=parsed.header?.$INSUNITS ?? null;
  return {
    writer:'@tarikjabiri/dxf',writerVersion:'2.9.0',
    parser:'dxf-parser',parserVersion:'1.1.2',
    byteLength:Buffer.byteLength(raw),
    entityCounts:counts,layers,insunits:units,
    expectedMillimeterInsunits:4,
    pass:required.every(t=>(counts[t]??0)>=1) && units===4 && (layers.CUT??0)>=1 && (layers.SCORE??0)>=1,
    note:'This closes JS writer/parser round-trip only. LightBurn and independent CAD GUI validation remains external.'
  };
}

async function safe(name,fn){
  try{
    const value=await fn();
    return {...value,executed:true};
  }catch(error){
    return {
      candidate:name,
      executed:true,
      pass:false,
      error:String(error),
      stack:error?.stack ?? null
    };
  }
}

const clipper=await safe('clipper2-ts',benchClipper);
const manifold=await safe('manifold-3d',benchManifold);
const dxf=await safe('DXF adapter stack',benchDxf);
const result={
  generatedAt:new Date().toISOString(),
  node:process.version,
  clipper,
  manifold,
  dxf,
};
fs.writeFileSync('results/kernel-results.json',JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));

const allPassed=
  clipper.pass===true &&
  manifold.lifecyclePass===true &&
  dxf.pass===true;
if(!allPassed) process.exitCode=2;
