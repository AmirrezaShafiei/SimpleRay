import {existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const files=['frontend/index.html','frontend/styles.css','frontend/main.js','frontend/model.js','frontend/config.js','frontend/store.js','frontend/xray-config.js','frontend/runtime.js','src-tauri/src/engine.rs','src-tauri/src/system_proxy.rs','src-tauri/tauri.conf.json','src-tauri/Cargo.toml','src-tauri/src/main.rs','src-tauri/src/lib.rs'];
for(const file of files){if(!existsSync(file))throw new Error(`Missing ${file}`)}
for(const file of ['frontend/main.js','frontend/model.js','frontend/config.js','frontend/store.js','frontend/xray-config.js','frontend/runtime.js','scripts/serve.mjs'])execFileSync(process.execPath,['--check',file],{stdio:'inherit'});
console.log('Phases 3–4 source files exist; JavaScript syntax checks passed. (Does not compile Rust)');
