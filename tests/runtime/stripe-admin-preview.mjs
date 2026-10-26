/** Isolated Vite preview. No app config, env files, API routes, worker or database. */
import fs from 'node:fs';
import path from 'node:path';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const root=process.cwd(),previewRoot=path.join(root,'tests/preview/stripe-admin');
const imageStub=path.join(root,'outputs/stripe-preview-image.jsx');
fs.writeFileSync(imageStub,"import React from 'react';export default function Image({src,alt,width,height}){return <img src={src} alt={alt} width={width} height={height}/>;}\n");
const server=await createServer({configFile:false,envFile:false,envDir:false,envPrefix:'PREVIEW_PUBLIC_',root:previewRoot,publicDir:false,plugins:[react(),{name:'synthetic-preview-only',configureServer(vite){vite.middlewares.use((req,res,next)=>{
 res.setHeader('Content-Security-Policy',"default-src 'self'; connect-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; form-action 'none'; frame-ancestors 'none'");
 res.setHeader('Cache-Control','no-store');
 if(req.url?.startsWith('/api/')){res.writeHead(403,{'Content-Type':'application/json'});res.end('{"error":"Preview has no backend API"}');return;}
 if(req.url==='/preview-base.css'){res.writeHead(200,{'Content-Type':'text/css'});res.end(fs.readFileSync('app/globals.css','utf8').replace('@import "tailwindcss";','')+'\nbody{margin:0;font-family:Arial,sans-serif}*{box-sizing:border-box}');return;}
 next();
 });}}],resolve:{alias:{'next/image':imageStub}},server:{host:'127.0.0.1',port:18925,strictPort:true,hmr:false,fs:{allow:[previewRoot,path.join(root,'app'),path.join(root,'lib'),path.join(root,'tests/helpers'),path.join(root,'node_modules'),imageStub],deny:['**/.env*','**/.git/**','**/*backup*','**/*.sql','**/*.zip','**/*.7z','**/*.dump','**/*.pem']}}});
await server.listen();
console.log('SYNTHETIC ADMIN PREVIEW: http://127.0.0.1:18925/?state=disabled');
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await server.close();process.exit(0);});
