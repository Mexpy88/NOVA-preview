import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import * as SheetJS from 'xlsx';

const headers=['SCAFFALE / FILA','BANCALE ','CODICE ARTICOLO','TAGLIA','NUOVO','SCARICATO','USATO','NOTE','DATA ULTIMO INVENTARIO'];
const master=SheetJS.utils.book_new();
const ws=SheetJS.utils.aoa_to_sheet([
  headers,
  ['STANZONE CDS FERRI','DISMESSI 19','CASACCA BIANCA/VERDE','M',53,0,0,'NOTA ORIGINALE',45678],
  ['R1','','I_ZERO','S',0,0,0,'RIGA ZERO',45679],
  ['65','SC9','I002BD','S',3,0,0,'DUPLICATO A',45680],
  ['65','SC9','I002BD','S',2,0,0,'DUPLICATO B',45681],
  ['R1','','I_FORMULA','M',20,0,0,'FORMULA PRESERVATA',45682],
  [],
  ['R2','','I_LAST','L',0,0,0,'ULTIMO ARTICOLO',45683],
]);
ws.E6={t:'n',f:'10+10',v:20};
ws.AK25={t:'s',v:'FOOTER FUORI TABELLA'};
ws['!ref']='A1:AK25';
SheetJS.utils.book_append_sheet(master,ws,'MAGAZZINO');
SheetJS.utils.book_append_sheet(master,SheetJS.utils.aoa_to_sheet([['APP_DATI legacy da ignorare']]),'APP_DATI');
SheetJS.utils.book_append_sheet(master,SheetJS.utils.aoa_to_sheet([['NOVA_DATI legacy da ignorare']]),'NOVA_DATI');
master.Workbook={Sheets:[{Hidden:0},{Hidden:2},{Hidden:2}]};
const input64=SheetJS.write(master,{bookType:'xlsx',type:'base64',compression:true});

const server=createServer((req,res)=>{
  if(!['/','/index.html'].includes((req.url||'').split('?')[0])){res.writeHead(404);res.end('Not found');return}
  res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
  res.end(readFileSync(resolve('index.html')))
});
await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
const browser=await chromium.launch({headless:true});
const context=await browser.newContext();
for(const path of [
  'node_modules/xlsx/dist/xlsx.full.min.js',
  'node_modules/jszip/dist/jszip.min.js',
  'node_modules/exceljs/dist/exceljs.min.js'
])await context.addInitScript({path:resolve(path)});
const page=await context.newPage();
try{
  await page.goto('http://127.0.0.1:'+server.address().port+'/',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>!!window.NOVA?.excel,{timeout:30000});
  const imported=await page.evaluate(async b64=>{
    const bytes=Uint8Array.from(atob(b64),ch=>ch.charCodeAt(0));
    const file=new File([bytes],'MASTER_REGRESSION.xlsx',{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
    const result=await window.NOVA.excel.importFile(file);
    // Replicate the production R31.98 import metadata gap.
    delete window.NOVA.store.db.master.rowCount;
    delete window.NOVA.store.db.master.tableEndRow;
    return {result,ledger:window.NOVA.store.db.ledger.length,stock:window.NOVA.domain.stock.positive().length}
  },input64);
  assert.equal(imported.ledger,0,'Old APP_DATI history must not be imported');
  assert.ok(imported.result.catalogRows>=6,'The source catalogue must import');
  console.log('PASS import DEMO ignores legacy history');

  const collect=()=>page.evaluate(async()=>{
    const bytes=await window.NOVA.excel.buildExportBytes();
    const book=window.XLSX.read(bytes,{type:'array',cellDates:false,cellFormula:true});
    const sheet=book.Sheets.MAGAZZINO;
    const rg=window.XLSX.utils.decode_range(sheet['!ref']);
    let rows=[];
    for(let r=1;r<=rg.e.r;r++){
      const val=c=>sheet[window.XLSX.utils.encode_cell({r,c})]?.v;
      if(val(2))rows.push({article:val(2),size:val(3),location:val(0),pallet:val(1),quantity:Number(val(4)||0),note:val(7),date:val(8),row:r+1})
    }
    const zip=await window.JSZip.loadAsync(bytes),tables=Object.keys(zip.files).filter(k=>/^xl\\/tables\\/table\\d+\\.xml$/.test(k));
    const footers=Object.keys(sheet).filter(k=>/^AK\\d+$/.test(k)&&sheet[k]?.v==='FOOTER FUORI TABELLA');
    return {rows,formula:sheet.E6?.f,formulaValue:sheet.E6?.v,footers,tableCount:tables.length,sheets:book.SheetNames,integrity:window.NOVA.excel.lastIntegrity,validation:window.NOVA.excel.lastValidation}
  });

  const baseline=await collect();
  const cas=(rows)=>rows.filter(x=>x.article==='CASACCA BIANCA/VERDE'&&x.size==='M');
  assert.equal(cas(baseline.rows).length,1);
  assert.equal(cas(baseline.rows)[0].quantity,53);
  assert.ok(baseline.rows.some(r=>r.article==='I_ZERO'&&r.quantity===0));
  assert.equal(baseline.rows.filter(r=>r.article==='I002BD').length,2);
  assert.equal(baseline.formula,'10+10');
  assert.ok(baseline.footers.length>0);
  assert.equal(cas(baseline.rows)[0].note,'NOTA ORIGINALE');
  assert.equal(Number(cas(baseline.rows)[0].date),45678);
  assert.ok(baseline.tableCount>=2);
  assert.equal(baseline.validation.ok,true);
  console.log('PASS no-op export: exact baseline, zero rows, duplicate identities, formulas, notes, dates, footer, tables');

  await page.evaluate(()=>{
    const d=window.NOVA.domain.ledger;
    d.incoming({article:'CASACCA BIANCA/VERDE',size:'M',state:'NUOVO'},{location:'STANZONE CDS FERRI',pallet:'DISMESSI 19'},7);
  });
  const afterIn=await collect();
  assert.equal(cas(afterIn.rows)[0].quantity,60);
  assert.ok(afterIn.rows.some(r=>r.article==='I_ZERO'&&r.quantity===0));
  assert.ok(afterIn.footers.length>0);
  console.log('PASS incoming +7 reconciled without inventing opening movements');

  await page.evaluate(()=>{
    const d=window.NOVA.domain.ledger;
    d.outgoing({article:'CASACCA BIANCA/VERDE',size:'M',state:'NUOVO'},{location:'STANZONE CDS FERRI',pallet:'DISMESSI 19'},60);
    d.transfer({article:'I002BD',size:'S',state:'NUOVO'},{location:'65',pallet:'SC9'},{location:'X',pallet:'PALLET-X'},2);
    d.incoming({article:'I_NEW',size:'L',state:'NUOVO'},{location:'X',pallet:'PALLET-Y'},11);
  });
  const changes=await collect();
  assert.equal(cas(changes.rows)[0].quantity,0,'Source catalogue line must be kept after depletion');
  assert.equal(changes.rows.filter(r=>r.article==='I002BD'&&r.location==='65').reduce((s,r)=>s+r.quantity,0),3);
  assert.equal(changes.rows.filter(r=>r.article==='I002BD'&&r.location==='X').reduce((s,r)=>s+r.quantity,0),2);
  assert.equal(changes.rows.filter(r=>r.article==='I_NEW').reduce((s,r)=>s+r.quantity,0),11);
  assert.ok(changes.rows.some(r=>r.article==='I_ZERO'&&r.quantity===0));
  assert.ok(changes.footers.length>0);
  assert.equal(changes.validation.ok,true);
  console.log('PASS zero depletion, transfer, new row, unaffected data, output tables');

  const integrity=await page.evaluate(async()=>{
    const db=window.NOVA.store.db;
    const row=db.master.rows.find(r=>r.article==='CASACCA BIANCA/VERDE'&&r.state==='NUOVO');
    row.quantity+=1;
    window.NOVA.domain.stock.invalidate();
    try{await window.NOVA.excel.buildExportBytes();return {blocked:false}}
    catch(e){return {blocked:true,error:String(e?.message||e)}}
  });
  assert.equal(integrity.blocked,true,'Mismatch MUST remain blocked');
  assert.match(integrity.error,/iniziale non coerente|anagrafica originale non riconciliata/);
  console.log('PASS integrity check blocks intentionally corrupted import baseline');
  console.log('ALL EXCEL INTEGRATION REGRESSIONS PASSED');
}finally{
  await context.close();await browser.close();await new Promise(ok=>server.close(ok))
}
