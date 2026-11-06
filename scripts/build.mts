import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
rmSync('dist',{recursive:true,force:true});
for(const config of ['tsconfig.json','tsconfig.browser.json']) execFileSync(process.execPath,[resolve('node_modules/typescript/bin/tsc'),'-p',config],{stdio:'inherit'});
mkdirSync('dist/dashboard/public',{recursive:true});
for(const file of ['index.html','style.css']) copyFileSync(`src/dashboard/public/${file}`,`dist/dashboard/public/${file}`);
