import fs from 'node:fs';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import XLSX from 'xlsx';
import JSZip from 'jszip';

const src=fs.readFileSync('index.html','utf8');
assert(src.includes('R31.94-20261001'));
assert(src.includes('async importFile(file,{restoreHistory=false}={})'));
assert(src.includes("filter(e=>this.#inCurrentCycle(e.at))"));
assert(src.includes('async #polishExportWithExcelJs(raw)'));

function methodBody(source, marker){
  const p=source.indexOf(marker); assert(p>=0,'method marker missing: '+marker);
  const open=source.indexOf('{',p); assert(open>=0);
  let depth=0, quote='', esc=false, tplDepth=0;
  for(let i=open;i<source.length;i++){
    const ch=source[i], prev=source[i-1];
    if(quote){
      if(esc){esc=false;continue}
      if(ch==='\\'){esc=true;continue}
      if(ch===quote){quote='';continue}
      if(quote==='\x60'&&ch==='$'&&source[i+1]==='{'){tplDepth++;i++;depth++;continue}
      continue
    }
    if(ch==="'"||ch==='"'||ch==='\x60'){quote=ch;continue}
    if(ch==='{')depth++;
    if(ch==='}'){depth--;if(depth===0)return source.slice(open+1,i)}
  }
  throw new Error('unbalanced method');
}

const body=methodBody(src,'async #polishExportWithExcelJs(raw)');
const ensureSomaExcelJs=async()=>ExcelJS;
const polish=eval('(async function(raw){'+body+'})');

const wb=XLSX.utils.book_new();
const add=(name,aoa)=>{
  const ws=XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(wb,ws,name);
  return ws;
};
add('MAGAZZINO',[
 ['SCAFFALE / FILA','BANCALE','ARTICOLO','TAGLIA','NUOVO','SCARICATO','USATO','NOTE','DATA ULTIMO INVENTARIO'],
 ['1','P1','I0001','M',10,0,0,'',new Date('2026-10-01T08:00:00')],
 ['2','P2','I0002','L',0,5,0,'test',new Date('2026-10-01T08:05:00')]
]);
const search=add('CERCA_GIACENZE',Array.from({length:18},()=>[]));
search.A1={t:'s',v:'CERCA GIACENZE MAGAZZINO'};
search.A2={t:'s',v:'INSERISCI ARTICOLO E TAGLIA'};
search.A3={t:'s',v:'ARTICOLO'}; search.B3={t:'s',v:''};
search.A4={t:'s',v:'TAGLIA'}; search.B4={t:'s',v:''};
search.A6={t:'s',v:'STATO'}; search.B6={t:'s',v:'TOTALE'};
['NUOVO','USATO','SCARICATO','DISMESSO','NON_CHIARO'].forEach((x,i)=>{search['A'+(7+i)]={t:'s',v:x};search['B'+(7+i)]={t:'n',v:0,f:'SUM(1,1)'}});
search.A12={t:'s',v:'TOTALE GENERALE'};search.B12={t:'n',v:0,f:'SUM(B7:B11)'};
search.A13={t:'s',v:'DATI GENERATI DA SOMA HUB'};
['FILA / SCAFFALE','BANCALE','ARTICOLO','TAGLIA','STATO','QUANTITÀ','NOTE'].forEach((x,i)=>{search[XLSX.utils.encode_cell({r:14,c:i})]={t:'s',v:x}});
for(let r=15;r<18;r++)for(let c=0;c<7;c++)search[XLSX.utils.encode_cell({r,c})]={t:'s',v:'',f:'IF(1=1,"","")'};
search['!ref']='A1:G18';
add('MOVIMENTI',[['ID','DATA / ORA','TIPO'],['1',new Date('2026-10-01T08:10:00'),'ENTRATA']]);
add('SCARICHI',[['SCARICO','DATA','OPERATORE'],['S1',new Date('2026-10-01T08:12:00'),'Mattia']]);
add('ENTRATE_MERCI',[['ENTRATA','FORNITORE','NUMERO DOCUMENTO'],['E1','TEST','D1']]);
add('RICHIESTE',[['RICHIESTA','DATA','DESTINAZIONE'],['R1',new Date('2026-10-01T08:15:00'),'LINA']]);
add('REGISTRO',[['DATA / ORA','OPERATORE','AREA'],[new Date('2026-10-01T08:16:00'),'Mattia','MASTER']]);
add('AUDIT',[['DATA / ORA','OPERATORE','AZIONE'],[new Date('2026-10-01T08:17:00'),'Mattia','MASTER_IMPORTED']]);
add('GIACENZE_RICERCA_DATI',[['FILA/SCAFFALE','BANCALE','ARTICOLO','TAGLIA','STATO','QUANTITÀ','NOTE','CHIAVE_RICERCA'],['1','P1','I0001','M','NUOVO',10,'','I0001|M|1']]);
add('NOVA_DATI',[['SO_MAGAZZINO_NOVA_V1'],['SCHEMA','NOVA_DB_V1']]);
wb.Workbook={Sheets:wb.SheetNames.map(name=>({name,Hidden:['GIACENZE_RICERCA_DATI','NOVA_DATI'].includes(name)?2:0}))};

const raw=XLSX.write(wb,{type:'array',bookType:'xlsx',cellStyles:true});
const polished=await polish(raw);
assert(polished instanceof Uint8Array && polished.byteLength>1000);

const out=new ExcelJS.Workbook();
await out.xlsx.load(polished.buffer.slice(polished.byteOffset,polished.byteOffset+polished.byteLength));
const expected=['MAGAZZINO','CERCA_GIACENZE','MOVIMENTI','SCARICHI','ENTRATE_MERCI','RICHIESTE','REGISTRO','AUDIT'];
for(const name of expected){
  const ws=out.getWorksheet(name);assert(ws,'missing sheet '+name);
  const tables=Object.keys(ws.tables||{});assert.equal(tables.length,1,name+' must have exactly one table');
}
assert.equal(out.getWorksheet('GIACENZE_RICERCA_DATI').state,'veryHidden');
assert.equal(out.getWorksheet('NOVA_DATI').state,'veryHidden');
assert(out.getWorksheet('CERCA_GIACENZE').getCell('B7').formula,'summary formula lost');
assert(out.getWorksheet('CERCA_GIACENZE').getCell('A16').formula,'search table formula lost');
assert.equal(out.getWorksheet('MAGAZZINO').getCell('A1').fill.fgColor.argb,'FF4472C4');
assert.equal(out.getWorksheet('MAGAZZINO').getCell('B1').fill.fgColor.argb,'FF8064A2');
assert(out.getWorksheet('MAGAZZINO').getCell('A2').border?.top?.style==='thin');

const zip=await JSZip.loadAsync(polished);
const tableFiles=Object.keys(zip.files).filter(p=>/^xl\/tables\/table\d+\.xml$/.test(p));
assert(tableFiles.length>=expected.length,'not enough table xml parts');
for(const path of tableFiles){
  const xml=await zip.file(path).async('string');
  assert(!/DxfId=/i.test(xml),path+' contains legacy DXF references');
  assert(/<table\b/.test(xml),path+' invalid table xml');
}
for(const path of Object.keys(zip.files).filter(p=>/^xl\/worksheets\/sheet\d+\.xml$/.test(p))){
  const xml=await zip.file(path).async('string');
  assert(!xml.includes('#REF!'),path+' contains #REF!');
}
console.log(JSON.stringify({ok:true,bytes:polished.byteLength,tables:tableFiles.length,sheets:out.worksheets.map(w=>({name:w.name,state:w.state,tables:Object.keys(w.tables||{}).length}))},null,2));
