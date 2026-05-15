import * as path from "path";
import { beforeAll } from "vitest";

import { setWasmDirectory } from "../src/cursor";

// sql.js needs to know where the .wasm asset lives. In production the
// extension's activate() points it at the bundled <extensionPath>/media
// directory; under vitest we point it at the same on-disk location used
// by `npm run copy-wasm`. Run `npm run copy-wasm` once before testing
// so the file exists.
beforeAll(() => {
  setWasmDirectory(path.join(__dirname, "..", "media"));
});
