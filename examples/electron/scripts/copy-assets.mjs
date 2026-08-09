import { copyFile } from "node:fs/promises";

await copyFile(
  new URL("../src/renderer.html", import.meta.url),
  new URL("../dist/renderer.html", import.meta.url),
);
