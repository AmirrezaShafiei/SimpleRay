import {existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const files=['frontend/index.html','frontend/styles.css','frontend/main.js','frontend/model.js','frontend/config.js','frontend/store.js','src-tauri/tauri.conf.json','src-tauri/Cargo.toml','src-tauri/src/main.rs','src-tauri/src/lib.rs'];
for(const file of files){if(!existsSync(file))throw new Error(`Missing ${file}`)}
for(const file of ['frontend/main.js','frontend/model.js','frontend/config.js','frontend/store.js','scripts/serve.mjs'])execFileSync(process.execPath,['--check',file],{stdio:'inherit'});
console.log('Phase 2 source files exist; JavaScript syntax checks passed. (Does not compile Rust)');
