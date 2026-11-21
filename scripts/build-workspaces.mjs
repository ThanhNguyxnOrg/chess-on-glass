import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const uiDir = fileURLToPath(new URL("../packages/ui", import.meta.url));
const tsc = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
const vite = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));
const copyBrand = fileURLToPath(new URL("../packages/ui/scripts/copy-brand-assets.mjs", import.meta.url));

function runStep(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: false
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

runStep(process.execPath, [tsc, "-b", "tsconfig.build.json", "--pretty", "false"], root);
runStep(process.execPath, [vite, "build"], uiDir);
runStep(process.execPath, [copyBrand], uiDir);
process.exit(0);
