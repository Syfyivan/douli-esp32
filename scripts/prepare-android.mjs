import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { resolve, join, dirname, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { crc32 } from "node:zlib";

const root = resolve(import.meta.dirname, "..");
const stage = join(root, ".runtime/android/payload");
const runtime = join(root, "android/runtime");
const assets = join(root, "android/app/src/main/assets");
mkdirSync(stage, { recursive: true }); mkdirSync(assets, { recursive: true });
const version = "24.22.0-0";
const expected = "9b068f4ad4c755f26c04b31883c536f037a4831e6575847a699cdf5fa72dde25";
const archive = join(root, `.runtime/android/nodejs-mobile-${version}.zip`);
if (!existsSync(archive)) {
  const tempArchive = `${archive}.tmp`;
  rmSync(tempArchive, { force: true });
  const url = `https://github.com/fogtape/nodejs-mobile/releases/download/v${version}/nodejs-mobile-android-${version}.zip`;
  if (process.platform === "win32") {
    // Honor the Windows system proxy used by the user's normal network stack.
    execFileSync("powershell.exe", ["-NoProfile", "-Command", `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri '${url}' -OutFile '${tempArchive.replaceAll("'", "''")}'`], { stdio: "inherit" });
  } else {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Runtime download: ${response.status}`);
    writeFileSync(tempArchive, Buffer.from(await response.arrayBuffer()));
  }
  renameSync(tempArchive, archive);
}
if (createHash("sha256").update(readFileSync(archive)).digest("hex") !== expected) {
  rmSync(archive, { force: true });
  throw new Error("Node mobile archive checksum mismatch");
}
const runtimeStamp = join(runtime, ".sha256");
if (
  !existsSync(join(runtime, "bin/arm64-v8a/libnode.so")) ||
  !existsSync(runtimeStamp) ||
  readFileSync(runtimeStamp, "utf8").trim() !== expected
) {
  rmSync(runtime, { recursive: true, force: true });
  mkdirSync(runtime, { recursive: true });
  if (process.platform === "win32")
    execFileSync("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${runtime.replaceAll("'", "''")}' -Force`], { stdio: "inherit" });
  else execFileSync("unzip", ["-oq", archive, "-d", runtime]);
  writeFileSync(runtimeStamp, `${expected}\n`);
}
for (const name of ["package.json", "package-lock.json"]) cpSync(join(root, name), join(stage, name));
const npm = process.env.npm_execpath || join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
execFileSync(process.execPath, [npm, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: stage, stdio: "inherit" });
for (const name of ["server", "dist", "licenses"]) {
  // Rebuild only these explicitly owned generated folders; never copy local data.
  rmSync(join(stage, name), { recursive: true, force: true });
  cpSync(join(root, name), join(stage, name), { recursive: true });
}
await import(pathToFileURL(join(stage, "server/app.mjs")));

// Small deterministic ZIP writer (stored entries): only explicitly owned runtime roots
// inside the staging directory are packaged. Private .data/.runtime files are never enumerated.
const compareCodepoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const excludedPackages = new Set(["react", "react-dom", "lucide-react", "scheduler"]);
const stageModules = join(stage, "node_modules");
const entries = [];
function walk(dir) {
  const sorted = readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareCodepoint(a.name, b.name));
  for (const e of sorted) {
    if (dir === stageModules && excludedPackages.has(e.name)) continue;
    if (e.isSymbolicLink()) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.isFile()) entries.push(full);
  }
}
for (const name of ["dist", "licenses", "node_modules", "package.json", "server"]) {
  const target = join(stage, name);
  if (!existsSync(target)) continue;
  const info = statSync(target);
  if (info.isDirectory()) walk(target);
  else if (info.isFile()) entries.push(target);
}
let offset = 0; const chunks = [], central = [];
for (const file of entries) {
  const name = Buffer.from(relative(stage, file).replaceAll("\\", "/"));
  const data = readFileSync(file), crc = crc32(data) >>> 0;
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
