import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,relative,extname,sep} from 'node:path';
const root=resolve('frontend');
const mime={'.html':'text/html;charset=utf-8','.js':'text/javascript;charset=utf-8','.css':'text/css;charset=utf-8','.svg':'image/svg+xml'};
const server=createServer(async(req,res)=>{
  try{
    const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    const full=resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
    if(relative(root,full).startsWith('..')||relative(root,full).startsWith(sep)||full===root){res.writeHead(403);res.end('Forbidden');return}
    const data=await readFile(full);res.writeHead(200,{'content-type':mime[extname(full)]||'application/octet-stream','x-content-type-options':'nosniff'});res.end(data);
  }catch{res.writeHead(404);res.end('Not found')}
});
server.listen(1420,'127.0.0.1',()=>console.log('SimpleRay Phase 2 preview: http://127.0.0.1:1420'));
