import { build } from "esbuild";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = dirname(fileURLToPath(import.meta.url));
const source = join(root, "../validation/understanding-map");
await mkdir(join(root, "dist"), { recursive: true });
await mkdir(join(root, "runtime"), { recursive: true });
for (const name of ["preview_server.py", "map_refresh.py", "native_navigation.py", "live-panel.html"]) {
  await copyFile(join(source, name), join(root, "runtime", name));
}
for (const name of ["init_tracker.py", "map_state.py", "publish_view.py", "reopen_map.py"]) {
  await copyFile(join(source, "skill-draft/understanding-map/scripts", name), join(root, "runtime", name));
}
// Bootstrap the packaged assets, then rebuild native helpers from current source.
execFileSync("python3", ["-c", `
import zipfile,sys
from pathlib import Path
with zipfile.ZipFile(sys.argv[1]) as archive:
 for item in archive.infolist():
  marker='payload/understanding-map/assets/'
  if marker not in item.filename or item.is_dir(): continue
  relative=item.filename.split(marker,1)[1]
  if '..' in Path(relative).parts: raise ValueError('invalid archive path')
  target=Path(sys.argv[2])/relative
  target.parent.mkdir(parents=True,exist_ok=True)
  target.write_bytes(archive.read(item))
  mode=(item.external_attr>>16)&0o777
  if mode: target.chmod(mode)
`, join(source, "releases/Understanding-Map-0.2.0-test.1.zip"), join(root, "runtime/assets")]);

execFileSync("python3", [join(source, "distribution/windows/build_helper.py"),
  "--output", join(root, "runtime/assets/windows/MapNavigator.exe")], { stdio: "pipe" });

if (process.platform === "darwin") {
  execFileSync("sh", [join(source, "native-helper/build_helper.sh")], {
    env: { ...process.env, UNDERSTANDING_MAP_HELPER_OUTPUT: join(root, "runtime/assets/native-helper/Understanding Map Navigator.app") },
    stdio: "pipe",
  });
  await copyFile(join(source, "native-helper/MapNavigator.swift"), join(root, "runtime/assets/native-helper/MapNavigator.swift"));
}

const bridge = await build({ entryPoints: [join(root, "panel.mjs")], bundle: true, format: "iife", platform: "browser", write: false });
let html = await readFile(join(source, "live-panel.html"), "utf8");
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const development = process.env.UNDERSTANDING_MAP_DEBUG === "1" && !process.argv.includes("--release");
html = html.replace("<main>", `<main data-plugin-version="${version}" data-development="${development}">`);
const scriptStart = html.lastIndexOf("<script>");
const scriptEnd = html.indexOf("</script>", scriptStart);
if (scriptStart < 0 || scriptEnd < 0) throw new Error("Map panel script was not found");
let script = html.slice(scriptStart + 8, scriptEnd);
script = script.replaceAll("fetch(", "window.understandingMapFetch(");
script = script.replace("${location.pathname}", "${window.understandingMapBinding.threadId}");
script = script.replaceAll("新消息由 Skill 整理后显示", "打开或刷新时整理新增消息");
html = html.slice(0, scriptStart) + "<script>" + bridge.outputFiles[0].text.replaceAll("</script", "<\\/script")
  + "\nwindow.understandingMapReady.then(() => {\n" + script + "\n}).catch(error => {document.querySelector('#refresh-status').textContent=error.message});\n</script>"
  + html.slice(scriptEnd + 9);
await writeFile(join(root, "dist/panel.html"), html);
await build({ entryPoints: [join(root, "server.mjs")], outfile: join(root, "dist/server.mjs"),
  bundle: true, format: "esm", platform: "node", target: "node20", packages: "bundle",
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});
console.log("Built Understanding Map Codex plugin.");
