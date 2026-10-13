import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

const headers=['SCAFFALE / FILA','BANCALE ','ARTICOLO','TAGLIA','NUOVO','SCARICATO','USATO','NOTE','DATA CONTROLLO QUANTITÀ'];
const originalBook=new ExcelJS.Workbook();
const sheet=originalBook.addWorksheet('MAGAZZINO',{pageSetup:{orientation:'landscape',paperSize:9,scale:160}});
sheet.addTable({name:'Tabella1',ref:'A1',headerRow:true,totalsRow:false,style:{theme:'TableStyleMedium2',showRowStripes:false},columns:headers.map(name=>({name})),rows:[
  ['R9','B1','I002BD','S',53,0,0,'Nota fondamentale',45678],
  ['R9','B1','I002BD','M',0,0,0,'Riga a giacenza zero',45679],
  ['R10','','I_LAST','L',8,0,0,'Ultima riga tabella',45680]
]});
sheet.getCell('F2').value={formula:'1-1',result:0};
sheet.getCell('C2').font={name:'Arial',size:13,bold:true,color:{argb:'FF0A316A'}};
sheet.getCell('C2').fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFFFE0AA'}};
sheet.getCell('C2').border={bottom:{style:'thin',color:{argb:'FF123456'}}};
sheet.getCell('I2').numFmt='dd/mm/yyyy';
sheet.getColumn(3).width=33;
sheet.getRow(2).height=29;
sheet.getCell('AK22').value='LITERAL_FOOTER';
const legacy=originalBook.addWorksheet('APP_DATI');legacy.addRow(['STORICO',100]);
const originalRaw=await originalBook.xlsx.writeBuffer();
const srcZip=await JSZip.loadAsync(originalRaw);
const sf='xl/worksheets/sheet1.xml';
let xml=await srcZip.file(sf).async('string');
if(!xml.includes('<pageSetup'))throw Error('Fixture missing pageSetup');
xml=xml.replace('<pageSetup','<pageSetup xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rIdOriginalPrinter"');
srcZip.file(sf,xml);
const relFile='xl/worksheets/_rels/sheet1.xml.rels';
let rels=await srcZip.file(relFile).async('string');
rels=rels.replace('</Relationships>','<Relationship Id="rIdOriginalPrinter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/printerSettings" Target="../printerSettings/printerSettings1.bin"/></Relationships>');
srcZip.file(relFile,rels);
srcZip.file('xl/printerSettings/printerSettings1.bin',Uint8Array.from([1,3,8,12,16,20,25,99]));
let ct=await srcZip.file('[Content_Types].xml').async('string');
ct=ct.replace('</Types>','<Default Extension="bin" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.printerSettings"/></Types>');
srcZip.file('[Content_Types].xml',ct);
const fixture=await srcZip.generateAsync({type:'base64'});

const server=createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(readFileSync(resolve('index.html')))});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const browser=await chromium.launch({headless:true});
const ctx=await browser.newContext();
for(const file of ['node_modules/xlsx/dist/xlsx.full.min.js','node_modules/jszip/dist/jszip.min.js','node_modules/exceljs/dist/exceljs.min.js'])await ctx.addInitScript({path:resolve(file)});
const page=await ctx.newPage();
try{
  await page.goto('http://127.0.0.1:'+server.address().port+'/');
  await page.waitForFunction(()=>!!window.NOVA?.excel);
  const first=await page.evaluate(async base64=>{
    const array=Uint8Array.from(atob(base64),x=>x.charCodeAt(0));
    await window.NOVA.excel.importFile(new File([array],'MASTER_STYLED.xlsx'));
    const bytes=await window.NOVA.excel.buildExportBytes();
    return {base64:btoa(String.fromCharCode(...new Uint8Array(bytes))),validation:window.NOVA.excel.lastValidation}
  },fixture);
  assert.equal(first.validation.ok,true,'SOMA must validate the styled original workbook');
  const exported=Buffer.from(first.base64,'base64'),file=await JSZip.loadAsync(exported);
  const outBook=new ExcelJS.Workbook();await outBook.xlsx.load(exported);
  const o=outBook.getWorksheet('MAGAZZINO');
  assert.equal(o.getColumn(3).width,33);
  assert.equal(o.getRow(2).height,29);
  assert.equal(o.getCell('C2').font?.bold,true);
  assert.equal(o.getCell('C2').font?.size,13);
  assert.equal(o.getCell('C2').fill?.fgColor?.argb,'FFFFE0AA');
  assert.equal(o.getCell('C2').border?.bottom?.color?.argb,'FF123456');
  assert.equal(o.getCell('I2').numFmt,'dd/mm/yyyy');
  assert.match(await file.file(sf).async('string'),/<c r="F2"[^>]*><f>1-1<\/f><v>0<\/v><\/c>/,'Cached zero must be explicit in worksheet OOXML');
  assert.equal(o.getCell('F2').value?.formula,'1-1');
  assert.equal(o.getCell('C2').value,'I002BD');
  assert.equal(o.getCell('AK22').value,'LITERAL_FOOTER');
  assert.equal(o.pageSetup.orientation,'landscape');
  assert.equal(o.pageSetup.paperSize,9);
  const table=await file.file('xl/tables/table1.xml').async('string');
  assert.match(table,/ref="A1:I4"/);
  assert.ok(!o.getCell('J1').value,'No unexpected extra table column');
  const sheetXml=await file.file(sf).async('string');
  assert.match(sheetXml,/rIdSomaMasterPrinter/);
  const binary=await file.file('xl/printerSettings/somaMasterPrinter.bin').async('uint8array');
  assert.deepEqual([...binary],[1,3,8,12,16,20,25,99]);
  assert.equal(outBook.getWorksheet('MAGAZZINO').getCell('H4').value,'Ultima riga tabella');
  console.log('PASS original structured table, style/font/fill/border, cache=0, date format, print binary, zero rows, footer, full range');

  const second=await page.evaluate(async()=>{
    window.NOVA.domain.ledger.incoming({article:'I002BD',size:'S',state:'NUOVO'},{location:'R9',pallet:'B1'},7);
    const b=await window.NOVA.excel.buildExportBytes();
    return {base64:btoa(String.fromCharCode(...new Uint8Array(b))),validation:window.NOVA.excel.lastValidation}
  });
  assert.equal(second.validation.ok,true);
  const changed=Buffer.from(second.base64,'base64'),changedZip=await JSZip.loadAsync(changed),changedBook=new ExcelJS.Workbook();
  await changedBook.xlsx.load(changed);
  const changedSheet=changedBook.getWorksheet('MAGAZZINO');
  assert.equal(changedSheet.getCell('E2').value?.result??changedSheet.getCell('E2').value,60);
  assert.equal(changedSheet.getColumn(3).width,33);
  assert.equal(changedSheet.pageSetup.orientation,'landscape');
  assert.match(await changedZip.file(sf).async('string'),/<c r="F2"[^>]*><f>1-1<\/f><v>0<\/v><\/c>/,'Unchanged cached formula zero must survive after a stock movement');
  assert.match(await changedZip.file('xl/tables/table1.xml').async('string'),/ref="A1:I4"/);
  console.log('PASS movement +7 on original structured table with stable layout and column range');
  // Full demo cycle: +7 inbound, -5 outbound, then transfer 3 units
  // without touching source master bytes or any unrelated catalogue field.
  const transaction=await page.evaluate(async()=>{
    const ledger=window.NOVA.domain.ledger;
    ledger.outgoing({article:'I002BD',size:'S',state:'NUOVO'},{location:'R9',pallet:'B1'},5);
    ledger.transfer({article:'I002BD',size:'S',state:'NUOVO'},{location:'R9',pallet:'B1'},{location:'R20',pallet:'B2'},3);
    const bytes=await window.NOVA.excel.buildExportBytes();
    const stock=window.NOVA.domain.stock.positive().filter(x=>x.article==='I002BD'||x.article==='I_LAST');
    return {base64:btoa(String.fromCharCode(...new Uint8Array(bytes))),validation:window.NOVA.excel.lastValidation,stock,ledgerCount:window.NOVA.store.db.ledger.length}
  });
  assert.equal(transaction.validation.ok,true);
  assert.equal(transaction.ledgerCount,3,'Expected exactly IN, OUT and TRANSFER in the fresh demo session');
  const transactionBuffer=Buffer.from(transaction.base64,'base64');
  const transactionZip=await JSZip.loadAsync(transactionBuffer);
  const transactionBook=new ExcelJS.Workbook();await transactionBook.xlsx.load(transactionBuffer);
  const inventory=transactionBook.getWorksheet('MAGAZZINO');
  const numberValue=cell=>{
    const value=cell.value;
    return typeof value==='object'&&value!==null?Number(value.result):Number(value||0)
  };
  const catalogueRows=[];
  inventory.eachRow({includeEmpty:false},(r,number)=>{
    if(number===1)return;
    const article=r.getCell(3).value;
    if(!['I002BD','I_LAST'].includes(article))return;
    catalogueRows.push({
      article,size:r.getCell(4).value,location:r.getCell(1).value||'',
      pallet:r.getCell(2).value||'',nuovo:numberValue(r.getCell(5)),
      scaricato:numberValue(r.getCell(6)),usato:numberValue(r.getCell(7)),
      note:r.getCell(8).value,date:r.getCell(9).value,physicalRow:number
    })
  });
  const findRow=(article,size,location,pallet='')=>{
    const matches=catalogueRows.filter(r=>r.article===article&&r.size===size&&r.location===location&&r.pallet===pallet);
    assert.equal(matches.length,1,'Expected one row for '+[article,size,location,pallet].join('/'));
    return matches[0]
  };
  const source=findRow('I002BD','S','R9','B1');
  const destination=findRow('I002BD','S','R20','B2');
  const unchangedZero=findRow('I002BD','M','R9','B1');
  const unchangedOther=findRow('I_LAST','L','R10');
  assert.equal(source.nuovo,52,'53 + 7 - 5 - 3 = 52 units at origin');
  assert.equal(destination.nuovo,3,'Transferred units must appear exactly once at destination');
  assert.equal(unchangedZero.nuovo,0,'Zero catalogue row must remain intact');
  assert.equal(unchangedOther.nuovo,8,'Unrelated stock must not change');
  assert.equal(source.note,'Nota fondamentale');
  assert.equal(source.date,45678);
  assert.equal(unchangedZero.note,'Riga a giacenza zero');
  assert.equal(unchangedZero.date,45679);
  assert.equal(unchangedOther.note,'Ultima riga tabella');
  assert.equal(unchangedOther.date,45680);
  assert.equal(catalogueRows.length,4,'One new destination and no unintended duplicate entries');
  assert.equal(catalogueRows.reduce((sum,r)=>sum+r.nuovo+r.scaricato+r.usato,0),63,
    'Stock conservation: (53+8)+7-5=63. Transfer has zero net effect');
  assert.deepEqual(transaction.stock.filter(r=>r.quantity>0).map(r=>[r.article,r.size,r.location,r.pallet,r.quantity])
    .sort((a,b)=>a.join('|').localeCompare(b.join('|'))),
    [['I002BD','S','R20','B2',3],['I002BD','S','R9','B1',52],['I_LAST','L','R10','',8]]
      .sort((a,b)=>a.join('|').localeCompare(b.join('|'))),
    'Export quantities must agree exactly with the live stock engine');
  assert.equal(inventory.getColumn(3).width,33);
  assert.equal(inventory.pageSetup.orientation,'landscape');
  assert.equal(inventory.pageSetup.paperSize,9);
  assert.equal(inventory.getCell('C2').font?.size,13);
  assert.equal(inventory.getCell('C2').font?.bold,true);
  assert.equal(inventory.getCell('C2').fill?.fgColor?.argb,'FFFFE0AA');
  assert.equal(inventory.getCell('C2').border?.bottom?.color?.argb,'FF123456');
  assert.equal(inventory.getCell('I2').numFmt,'dd/mm/yyyy');
  assert.match(await transactionZip.file(sf).async('string'),
    /<c r="F2"[^>]*><f>1-1<\/f><v>0<\/v><\/c>/,
    'Unchanged cached zero and formula must survive all three movements');
  assert.match(await transactionZip.file('xl/tables/table1.xml').async('string'),
    /ref="A1:I5"/,'Structured table must expand by one row and still have nine columns');
  const outFooter=[];
  inventory.eachRow({includeEmpty:false},r=>{if(r.getCell(37).value==='LITERAL_FOOTER')outFooter.push(r.number)});
  assert.equal(outFooter.length,1,'Footer outside the table must be preserved exactly once');
  assert.equal(transactionBook.getWorksheet('APP_DATI'),undefined,'Legacy history must not reappear');
  console.log('PASS isolated three-movement cycle: IN +7, OUT -5, TRANSFER 3; source 52, destination 3, unchanged 8 and zero, total 63');
  console.log('PASS no duplication and unchanged notes, inventory dates, formula cache, styles, print setup, external footer, 9-column structured table');

}finally{await ctx.close();await browser.close();await new Promise(done=>server.close(done))}
