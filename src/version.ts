declare const __APP_VERSION__: string;

/** The release number: package.json is the only place it is written, the build injects it. */
export const APP_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
