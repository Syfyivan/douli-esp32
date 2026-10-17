import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { resolve, join, dirname, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const stage = join(root, ".runtime/android/payload");
const runtime = join(root, "android/runtime");
const assets = join(root, "android/app/src/main/assets");
mkdirSync(stage, { recursive: true }); mkdirSync(assets, { recursive: true });
const version = "24.22.0-0";
const expected = "9b068f4ad4c755f26c04b31883c536f037a4831e6575847a699cdf5fa72dde25";
const archive = join(root, `.runtime/android/nodejs-mobile-${version}.zip`);
if (!existsSync(archive)) {
  const url=`https://github.com/fogtape/nodejs-mobile/releases/download/v${version}/nodejs-mobile-android-${version}.zip`;
  if (process.platform === "win32") {
    // Honor the Windows system proxy used by the user's normal network stack.
    execFileSync("powershell.exe",["-NoProfile","-Command",`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri '${url}' -OutFile '${archive.replaceAll("'","''")}'`],{stdio:"inherit"});
  } else {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Runtime download: ${response.status}`);
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  }
}
if (createHash("sha256").update(readFileSync(archive)).digest("hex") !== expected)
  throw new Error("Node mobile archive checksum mismatch");
if (!existsSync(join(runtime, "bin/arm64-v8a/libnode.so"))) {
  if (process.platform === "win32")
    execFileSync("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${runtime.replaceAll("'", "''")}' -Force`], { stdio: "inherit" });
  else execFileSync("unzip", ["-q", archive, "-d", runtime]);
}
for (const name of ["package.json", "package-lock.json"]) cpSync(join(root, name), join(stage, name));
const npm = process.env.npm_execpath || join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
execFileSync(process.execPath, [npm, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: stage, stdio: "inherit" });
for (const name of ["server", "dist", "licenses"]) {
  // Rebuild only these explicitly owned generated folders; never copy local data.
  rmSync(join(stage,name),{recursive:true,force:true});
  cpSync(join(root, name), join(stage, name), { recursive: true });
}
await import(pathToFileURL(join(stage,"server/app.mjs")));

// Small deterministic ZIP writer (stored entries): only the explicit code/dependency
// staging directory is packaged. Private .data/.runtime files are never enumerated.
const table = Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function crc32(bytes) { let crc = 0xffffffff; for (const b of bytes) crc = table[(crc ^ b) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
const entries = [];
function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    const path = join(dir, e.name);
    if(dir === join(stage,"node_modules") && ["react","react-dom","lucide-react","scheduler"].includes(e.name)) continue;
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) walk(path);
    else entries.push(path);
  }
}
walk(stage);
let offset = 0; const chunks = [], central = [];
for (const file of entries) {
  const name = Buffer.from(relative(stage, file).replaceAll("\\", "/"));
  const data = readFileSync(file), crc = crc32(data);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20,4); header.writeUInt16LE(0x800,6);
  header.writeUInt32LE(crc,14); header.writeUInt32LE(data.length,18); header.writeUInt32LE(data.length,22); header.writeUInt16LE(name.length,26);
  const index = Buffer.alloc(46);
  index.writeUInt32LE(0x02014b50); index.writeUInt16LE(20,4); index.writeUInt16LE(20,6); index.writeUInt16LE(0x800,8);
  index.writeUInt32LE(crc,16); index.writeUInt32LE(data.length,20); index.writeUInt32LE(data.length,24); index.writeUInt16LE(name.length,28); index.writeUInt32LE(offset,42);
  chunks.push(header,name,data); central.push(index,name); offset += header.length + name.length + data.length;
}
const directory = Buffer.concat(central), end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length,8); end.writeUInt16LE(entries.length,10); end.writeUInt32LE(directory.length,12); end.writeUInt32LE(offset,16);
const zip = Buffer.concat([...chunks,directory,end]);
writeFileSync(join(assets,"runtime.zip"),zip);
writeFileSync(join(assets,"runtime-version.txt"),createHash("sha256").update(zip).digest("hex"));
console.log(`Android assets ready: ${entries.length} code/dependency files, ${(zip.length / 1048576).toFixed(1)} MB; no user data.`);
