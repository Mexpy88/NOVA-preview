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
  assert.match(await changedZip.file('xl/tables/table1.xml').async('string'),/ref="A1:I4"/);
  console.log('PASS movement +7 on original structured table with stable layout and column range');
}finally{await ctx.close();await browser.close();await new Promise(done=>server.close(done))}
