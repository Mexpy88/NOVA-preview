import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {chromium} from 'playwright';

const server=createServer((req,res)=>{
  res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
  res.end(readFileSync(resolve('index.html')));
});
await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
const browser=await chromium.launch({headless:true});
const context=await browser.newContext();
const page=await context.newPage();
try{
  await page.goto('http://127.0.0.1:'+server.address().port+'/');
  await page.waitForFunction(()=>!!window.NOVA?.ui?.globalSearchEntries);
  const result=await page.evaluate(()=>{
    const assert={
      equal(a,b,m='equal'){if(!Object.is(a,b))throw Error(m+': '+String(a)+' !== '+String(b))},
      strictEqual(a,b,m='strictEqual'){if(!Object.is(a,b))throw Error(m+': unexpected identity')},
      notStrictEqual(a,b,m='notStrictEqual'){if(Object.is(a,b))throw Error(m+': references identical')},
      ok(value,m='assert.ok'){if(!value)throw Error(m)},
      match(value,pattern,m='assert.match'){if(!pattern.test(String(value)))throw Error(m+': '+String(value))}
    };
    const {store,ui,domain,auth}=window.NOVA;
    const originalCan=auth.can.bind(auth),originalLina=auth.isLina.bind(auth);
    auth.can=cap=>cap==='STOCK_VIEW'||cap==='MOVE';
    auth.isLina=()=>false;
    try{
      const rows=Array.from({length:8500},(_,i)=>({
        article:'I'+String(i).padStart(5,'0'),size:i%3===0?'M':i%3===1?'S':'L',
        state:'NUOVO',location:'F'+String(Math.floor(i/100)).padStart(3,'0'),
        pallet:'P'+String(i%10),quantity:5,description:'TEST',
      }));
      store.db.master.rows=rows;
      store.db.ledger=[];
      store.db.requests=[];store.db.receipts=[];store.db.audits=[];
      domain.stock.invalidate();
      const baseSnapshot=domain.stock.rows();
      assert.equal(baseSnapshot.length,8500);
      const origFold=ui.globalSearchFold.bind(ui);
      let foldCalls=0;
      ui.globalSearchFold=value=>{foldCalls++;return origFold(value)};
      const one=ui.globalSearchEntries('I00042');
      assert.equal(one.filter(r=>r.category==='GIACENZE').length,1);
      assert.equal(one[0].key.split('|')[0],'I00042');
      const firstCalls=foldCalls;
      assert.ok(firstCalls>=8500&&firstCalls<=8550,'Initial 8,500 entries are folded only once');
      const cache=ui.globalSearchStockCache;
      assert.equal(cache.siteId,store.siteId);
      assert.equal(cache.entries.length,8500);
      const two=ui.globalSearchEntries('I00043');
      assert.equal(two.filter(r=>r.category==='GIACENZE').length,1);
      const repeatedCalls=foldCalls-firstCalls;
      assert.ok(repeatedCalls<=3,'Repeated keystrokes must not normalize all stock rows again');
      assert.strictEqual(ui.globalSearchStockCache,cache,'Index must be reused for same stock snapshot');
      const flexible=ui.globalSearchEntries('F000 P2');
      assert.ok(flexible.length>0,'Location/pallet multi-term search must continue to work');
      const exactKey=one[0].key;
      const before=domain.stock.findByKey(exactKey);
      assert.equal(before.quantity,5);
      domain.ledger.incoming({article:'I00042',size:'M',state:'NUOVO'},{location:'F000',pallet:'P2'},7);
      const afterSnapshot=domain.stock.rows();
      assert.notStrictEqual(afterSnapshot,baseSnapshot,'Movement must invalidate stock snapshot');
      const modified=ui.globalSearchEntries('I00042');
      assert.equal(modified.length,1);
      assert.match(modified[0].meta,/12 pz/,'Search index must show new quantity after ledger');
      assert.notStrictEqual(ui.globalSearchStockCache,cache,'Movement must invalidate search index');
      const afterMovementCalls=foldCalls;
      assert.ok(afterMovementCalls>firstCalls+8000,'Movement must rebuild the index once');

      // Critical cross-site isolation: silent site changes emit no db:changed event.
      store.useSite('FERRARA',{silent:true});
      store.db.master.rows=[{article:'I_SITE_ONLY',size:'L',state:'NUOVO',location:'AREA_B',pallet:'PX',quantity:19}];
      store.db.ledger=[];
      assert.notStrictEqual(domain.stock.rows(),afterSnapshot,
        'Different site database must never reuse prior cached stock even with silent:true');
      assert.equal(domain.stock.rows().length,1);
      assert.equal(ui.globalSearchEntries('I00042').filter(x=>x.category==='GIACENZE').length,0,
        'Previous site stock must never appear in new site results');
      assert.equal(ui.globalSearchEntries('I_SITE_ONLY').filter(x=>x.category==='GIACENZE').length,1);
      assert.equal(ui.globalSearchStockCache.siteId,'FERRARA');
      assert.equal(ui.globalSearchStockCache.entries.length,1);

      // Auth changes must not expose cached stock entries.
      auth.can=()=>false;
      assert.equal(ui.globalSearchEntries('I_SITE_ONLY').filter(x=>x.category==='GIACENZE').length,0);
      return {seeded:rows.length,foldedInitially:firstCalls,foldedAfterSecondQuery:repeatedCalls,
        afterMovement:modified[0].meta,isolatedSite:'FERRARA',authProtected:true};
    }finally{auth.can=originalCan;auth.isLina=originalLina}
  });
  assert.equal(result.seeded,8500);
  console.log('PASS 8,500-stock-row search index',JSON.stringify(result));
  console.log('PASS movement invalidation, silent site isolation, login capability filter');
}finally{
  await context.close();await browser.close();await new Promise(done=>server.close(done));
}
