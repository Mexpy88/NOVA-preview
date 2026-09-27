import fs from 'node:fs';
import path from 'node:path';

fs.mkdirSync('results',{recursive:true});

const seenDirs=new Set();
const packages=[];

function addPackage(dir){
  const real=fs.realpathSync(dir);
  if(seenDirs.has(real)) return;
  seenDirs.add(real);
  const pj=path.join(dir,'package.json');
  if(!fs.existsSync(pj)) return;
  try{
    const p=JSON.parse(fs.readFileSync(pj,'utf8'));
    packages.push({
      name:p.name ?? '(unknown)',
      version:p.version ?? null,
      license:p.license ?? null,
      repository:p.repository ?? null,
      path:path.relative(process.cwd(),dir),
    });
  }catch(error){
    packages.push({
      name:path.basename(dir),version:null,license:null,
      repository:null,path:path.relative(process.cwd(),dir),
      readError:String(error)
    });
  }
  const nested=path.join(dir,'node_modules');
  if(fs.existsSync(nested)) walkNodeModules(nested);
}

function walkNodeModules(nm){
  if(!fs.existsSync(nm)) return;
  for(const ent of fs.readdirSync(nm,{withFileTypes:true})){
    if(!ent.isDirectory() || ent.name==='.bin') continue;
    const full=path.join(nm,ent.name);
    if(ent.name.startsWith('@')){
      for(const scoped of fs.readdirSync(full,{withFileTypes:true})){
        if(scoped.isDirectory()) addPackage(path.join(full,scoped.name));
      }
    }else{
      addPackage(full);
    }
  }
}

walkNodeModules(path.join(process.cwd(),'node_modules'));

const unique=new Map();
for(const p of packages){
  const key=`${p.name}@${p.version}`;
  if(!unique.has(key)) unique.set(key,p);
}
const rows=[...unique.values()].sort((a,b)=>
  (String(a.name)+String(a.version)).localeCompare(String(b.name)+String(b.version))
);

function classify(license){
  if(!license) return 'UNKNOWN';
  const s=String(license).toUpperCase();
  const hasStrong=/(AGPL|(^|[^L])GPL-)/.test(s);
  const permissiveAlternative=/\bOR\b/.test(s) &&
    /(MIT|APACHE|BSD|ISC|BSL-1\.0|BOOST SOFTWARE LICENSE)/.test(s);
  if(hasStrong && !permissiveAlternative) return 'STRONG_COPYLEFT_REVIEW';
  if(/LGPL|MPL/.test(s)) return 'WEAK_COPYLEFT_REVIEW';
  return 'OK';
}

const classified=rows.map(p=>({...p,classification:classify(p.license)}));
const summary={
  totalUniquePackages:classified.length,
  ok:classified.filter(p=>p.classification==='OK').length,
  strongCopyleftReview:classified.filter(p=>p.classification==='STRONG_COPYLEFT_REVIEW'),
  weakCopyleftReview:classified.filter(p=>p.classification==='WEAK_COPYLEFT_REVIEW'),
  unknown:classified.filter(p=>p.classification==='UNKNOWN'),
};
const out={
  generatedAt:new Date().toISOString(),
  policy:'Automated evidence only; final legal/license review is human-reviewed against exact lockfile and selected feature set.',
  packages:classified,
  summary,
};
fs.writeFileSync('results/license-scan.json',JSON.stringify(out,null,2));
console.log(JSON.stringify(summary,null,2));
