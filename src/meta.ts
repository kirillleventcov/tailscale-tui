import pkg from "../package.json" with { type: "json" };

/** Command name, shown in the help overlay, hints and the terminal title. */
export const NAME = "tsexit";
export const VERSION: string = pkg.version;
