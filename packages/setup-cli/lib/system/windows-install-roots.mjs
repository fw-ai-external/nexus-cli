export function windowsProgramFilesRoots(env) {
  return [...new Set([env.ProgramW6432, env.ProgramFiles, env["ProgramFiles(x86)"]].filter(Boolean))];
}

export function withDefaultWindowsProgramFilesRoots(roots) {
  return roots.length ? roots : ["C:\\Program Files", "C:\\Program Files (x86)"];
}
