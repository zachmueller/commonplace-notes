import esbuild from "esbuild";
import process from "process";
import { bundleOptions } from "./esbuild.options.mjs";

const prod = (process.argv[2] === "production");

const context = await esbuild.context(bundleOptions(prod));

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
