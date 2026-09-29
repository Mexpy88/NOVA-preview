const WINDOW_MS=60_000;
const MAX_PER_WINDOW=30;

function allowedOrigin(req){
  const origin=String(req.headers.origin||'').replace(/\/$/,'');
  if(!origin)return '';
  const host=String(req.headers.host||'');
  if(origin===`https://${host}`||origin===`http://${host}`)return origin;
  const extra=String(process.env.SOMA_ALLOWED_ORIGINS||'https://mexpy88.github.io')
    .split(',').map(x=>x.trim().replace(/\/$/,'')).filter(Boolean);
  return extra.includes(origin)?origin:null;
}

function rateLimited(req){
  const ip=String(req.headers['x-forwarded-for']||req.headers['x-real-ip']||'unknown').split(',')[0].trim();
  const now=Date.now();
  const store=globalThis.__SOMA_SPEECH_RATE__||(globalThis.__SOMA_SPEECH_RATE__=new Map());
  const hit=store.get(ip);
  if(!hit||now-hit.start>=WINDOW_MS){store.set(ip,{start:now,count:1});return false}
  hit.count+=1;
  return hit.count>MAX_PER_WINDOW;
}

export default async function handler(req,res){
  const origin=allowedOrigin(req);
  if(origin===null)return res.status(403).json({error:'Origin not allowed'});
  if(origin){
    res.setHeader('Access-Control-Allow-Origin',origin);
    res.setHeader('Vary','Origin');
  }
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  res.setHeader('Cache-Control','no-store, max-age=0');

  if(req.method==='OPTIONS')return res.status(204).end();
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  if(rateLimited(req))return res.status(429).json({error:'Too many token requests'});

  const key=process.env.AZURE_SPEECH_KEY;
  const region=process.env.AZURE_SPEECH_REGION;
  if(!key||!region)return res.status(503).json({error:'Azure Speech is not configured'});

  const url=`https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;
  try{
    const r=await fetch(url,{
      method:'POST',
      headers:{
        'Ocp-Apim-Subscription-Key':key,
        'Content-Type':'application/x-www-form-urlencoded'
      },
      body:''
    });
    if(!r.ok){
      const detail=(await r.text()).slice(0,300);
      return res.status(502).json({error:'Azure token request failed',status:r.status,detail});
    }
    const token=await r.text();
    return res.status(200).json({
      token,
      region,
      expiresIn:540,
      issuedAt:Date.now()
    });
  }catch(error){
    return res.status(502).json({error:'Azure token request failed',detail:String(error?.message||error)});
  }
}
