import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

fs.mkdirSync('results',{recursive:true});

const raw=execFileSync('npm',['query','.','--json'],{encoding:'utf8'});
const rows=JSON.parse(raw)
  .filter(p=>p.location && p.location!=='.')
  .map(p=>({
    name:p.name ?? '(unknown)',
    version:p.version ?? null,
    license:p.license ?? null,
    location:p.location,
    resolved:p.resolved ?? null,
  }));

const unique=new Map();
for(const p of rows){
  const key=`${p.name}@${p.version}`;
  if(!unique.has(key)) unique.set(key,p);
}
const packages=[...unique.values()].sort((a,b)=>
  (a.name+a.version).localeCompare(b.name+b.version)
);

function classify(license){
  if(!license) return 'UNKNOWN';
  const s=String(license).toUpperCase();
  // Strong copyleft only when no explicit permissive OR alternative is visible.
  const strong=/(^|[^L])GPL-|AGPL-/.test(s);
  const permissiveAlternative=/\bOR\b/.test(s) &&
    /(MIT|APACHE|BSD|ISC|BSL-1\.0|BOOST SOFTWARE LICENSE)/.test(s);
  if(strong && !permissiveAlternative) return 'STRONG_COPYLEFT_REVIEW';
  if(/LGPL|MPL/.test(s)) return 'WEAK_COPYLEFT_REVIEW';
  return 'OK';
}

const classified=packages.map(p=>({...p,classification:classify(p.license)}));
const summary={
  totalUniquePackages:classified.length,
  strongCopyleftReview:classified.filter(p=>p.classification==='STRONG_COPYLEFT_REVIEW'),
  weakCopyleftReview:classified.filter(p=>p.classification==='WEAK_COPYLEFT_REVIEW'),
  unknown:classified.filter(p=>p.classification==='UNKNOWN'),
};
const out={
  generatedAt:new Date().toISOString(),
  policy:'Automated evidence only; final legal/license review is human-reviewed against exact lockfile and feature set.',
  packages:classified,
  summary,
};
fs.writeFileSync('results/license-scan.json',JSON.stringify(out,null,2));
console.log(JSON.stringify(summary,null,2));
