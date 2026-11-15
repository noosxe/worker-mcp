// Stands in for `@earendil-works/pi-coding-agent` where the gate imports pi's
// own tool definitions (see the loader hook in fake-pi.mjs).
export const createReadToolDefinition = (cwd) => ({ name: "read", cwd });
export const createBashToolDefinition = (cwd) => ({ name: "bash", cwd });
export const createEditToolDefinition = (cwd) => ({ name: "edit", cwd });
export const createWriteToolDefinition = (cwd) => ({ name: "write", cwd });
export const createGrepToolDefinition = (cwd) => ({ name: "grep", cwd });
export const createFindToolDefinition = (cwd) => ({ name: "find", cwd });
export const createLsToolDefinition = (cwd) => ({ name: "ls", cwd });
