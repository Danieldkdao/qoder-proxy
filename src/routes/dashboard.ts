import { Router } from 'express';
import { join } from 'node:path';
import config from '../config';
import { secretsEqual } from '../middleware/auth';
import { dashboardAuth, createToken, setCookie, clearCookie, getToken, revokeToken } from '../middleware/dashboardAuth';
import { clearRequests, clearSystem, getRequests, getSystem } from '../store/logStore';
import { QODER_MODELS } from '../helpers/format';
import { processStats } from '../helpers/spawn';
import { handleChat } from './chat';
export const dashboardRouter=Router();
const publicDir=join(__dirname,'../dashboard/public');
// One bounded global limiter avoids unbounded attacker-controlled IP maps.
let attempts=0, windowStart=Date.now();
dashboardRouter.get('/login',(_req,res)=>res.sendFile(join(publicDir,'index.html')));
dashboardRouter.post('/login',(req,res)=>{
  if (Date.now()-windowStart>60000) {attempts=0;windowStart=Date.now();}
  if (++attempts>10) {res.status(429).send('Too many login attempts; try again in one minute');return;}
  const password:unknown=req.body?.password;
  if (config.DASHBOARD_PASSWORD && typeof password==='string' && secretsEqual(password,config.DASHBOARD_PASSWORD)) {setCookie(res,createToken());res.redirect('/dashboard/');}
  else res.redirect('/dashboard/login?error=1');
});
dashboardRouter.get('/logout',(req,res)=>{revokeToken(getToken(req));clearCookie(res);res.redirect('/dashboard/login');});
dashboardRouter.use(dashboardAuth);
dashboardRouter.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
dashboardRouter.get('/',(_req,res)=>res.sendFile(join(publicDir,'index.html')));
dashboardRouter.get('/api/config',(_req,res)=>res.json({publicBaseUrl:config.PUBLIC_BASE_URL||'',authEnabled:!!config.API_KEY,version:'3.0.0',payloadLogging:config.LOG_PAYLOADS}));
dashboardRouter.get('/api/models',(_req,res)=>res.json({models:QODER_MODELS}));
dashboardRouter.get('/api/status',(_req,res)=>res.json({status:'ok',uptime:process.uptime(),proxyMemoryMB:Math.round(process.memoryUsage().rss/1024/1024),...processStats(),note:'Memory includes the Node proxy only, not CLI children'}));
dashboardRouter.use('/api',(req,res,next)=>{
  if (['POST','DELETE','PUT','PATCH'].includes(req.method) && (req.headers['x-dashboard-request']!=='1' || (req.headers.origin && req.headers.origin !== `${req.protocol}://${req.get('host')}`))) {res.status(403).json({error:'Dashboard request header and same origin required'});return;}
  next();
});
dashboardRouter.post('/api/chat',(req,res)=>{void handleChat(req,res);});
dashboardRouter.get('/api/logs',(_req,res)=>res.json({logs:getRequests()}));
dashboardRouter.delete('/api/logs',(_req,res)=>{clearRequests();res.json({ok:true});});
dashboardRouter.get('/api/logs/system',(_req,res)=>res.json({logs:getSystem()}));
dashboardRouter.delete('/api/logs/system',(_req,res)=>{clearSystem();res.json({ok:true});});
