import {existsSync,readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const files=[
'frontend/index.html','frontend/styles.css','frontend/main.js','frontend/model.js','frontend/config.js','frontend/extra-profiles.js','frontend/store.js','frontend/xray-config.js','frontend/runtime.js','frontend/flags.js','frontend/theme.js','frontend/phone-transfer.js',
'src-tauri/src/engine.rs','src-tauri/src/system_proxy.rs','src-tauri/src/preferences.rs','src-tauri/src/tray.rs','src-tauri/src/lib.rs','src-tauri/src/main.rs','src-tauri/src/phone_transfer.rs','src-tauri/src/phone_transfer_form.html',
'src-tauri/tauri.conf.json','src-tauri/Cargo.toml','.github/workflows/windows-beta.yml','scripts/stage-xray.ps1'];
for(const file of files){if(!existsSync(file))throw new Error(`Missing ${file}`)}
for(const file of ['frontend/main.js','frontend/model.js','frontend/config.js','frontend/extra-profiles.js','frontend/store.js','frontend/xray-config.js','frontend/runtime.js','frontend/flags.js','frontend/theme.js','frontend/phone-transfer.js','scripts/serve.mjs'])execFileSync(process.execPath,['--check',file],{stdio:'inherit'});
const pkg=JSON.parse(readFileSync('package.json','utf8'));
const tauri=JSON.parse(readFileSync('src-tauri/tauri.conf.json','utf8'));
if(pkg.version!==tauri.version)throw Error('Package/Tauri version mismatch');
const cargo=readFileSync('src-tauri/Cargo.toml','utf8');
if(!cargo.includes(`version = "${pkg.version}"`))throw Error('Cargo/Tauri version mismatch');
if(!tauri.bundle.resources.includes('binaries/xray.exe'))throw Error('Installer must include core runtime');
console.log('JavaScript syntax, source structure, package version and Tauri resource checks passed. (Not a Rust compile)');
