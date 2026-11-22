import { constants, closeSync, fchmodSync, fstatSync, mkdirSync, openSync } from "node:fs";
import { lstat, mkdir, open, readdir, readlink, realpath, symlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { writeFileAtomic } from "./atomic-write.mjs";

export async function writePrivateFileAtomic(filePath, data, { root, ...options } = {}) {
  ensurePrivateParent(filePath, { root });
  await writeFileAtomic(filePath, data, { mode: 0o600, ...options });
}

export function ensurePrivateParent(filePath, { create = true, root, platform = process.platform, uid = process.getuid?.() } = {}) {
  const parent = path.dirname(path.resolve(filePath));
  if (platform === "win32") {
    if (create) mkdirSync(parent, { recursive: true, mode: 0o700 });
    return;
  }
  const boundary = root ? path.resolve(root) : parent;
  const relative = path.relative(boundary, parent);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Invalid private directory boundary");
  if (create) mkdirSync(path.dirname(boundary), { recursive: true, mode: 0o700 });
  const dirs = [boundary];
  for (const part of path.relative(boundary, parent).split(path.sep).filter(Boolean)) {
    dirs.push(path.join(dirs.at(-1), part));
  }
  for (const dir of dirs) {
    let fd;
    try {
      if (create) {
        try { mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
      }
      fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = fstatSync(fd);
      if (!info.isDirectory() || info.uid !== uid) throw new Error("Unsafe private directory");
      if ((info.mode & 0o7777) !== 0o700) fchmodSync(fd, 0o700);
    } catch (error) {
      if (error.code === "ENOENT" && !create) throw error;
      throw new Error("Cannot secure private files. Check directory ownership, permissions, and symlinks.");
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}

export async function copyPrivateTree(source, destination, { sourceSymlink = "reject" } = {}) {
  const resolvedSource = sourceSymlink === "follow" ? await realpath(source) : source;
  const modes = [];
  await copyTreeEntry(resolvedSource, destination, sourceSymlink === "preserve", modes, "");
  return modes;
}

async function copyTreeEntry(source, destination, allowSymlink, modes, relative) {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const info = await lstat(source);
  if (info.isSymbolicLink()) {
    if (!allowSymlink) throw new Error("Cannot back up a symbolic root.");
    await symlink(path.resolve(path.dirname(source), await readlink(source)), destination);
    return;
  }
  if (info.isDirectory()) {
    modes.push([relative, info.mode & 0o7777]);
    await mkdir(destination, { mode: 0o700 });
    for (const name of await readdir(source)) {
      await copyTreeEntry(path.join(source, name), path.join(destination, name), true, modes, path.join(relative, name));
    }
    return;
  }
  let input;
  let output;
  try {
    input = await open(source, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
    const opened = await input.stat();
    if (!opened.isFile()) throw new Error("Cannot back up a special file.");
    modes.push([relative, opened.mode & 0o7777]);
    output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
      | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW), 0o600);
    await output.writeFile(await input.readFile());
  } finally {
    await output?.close();
    await input?.close();
  }
}

export async function restoreTreeModes(directory, modes) {
  if (process.platform === "win32") return;
  const byPath = new Map(modes.filter((entry) => Array.isArray(entry) && typeof entry[0] === "string"
    && Number.isInteger(entry[1]) && entry[1] >= 0 && entry[1] <= 0o7777));
  async function visit(file, relative) {
    const info = await lstat(file);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      for (const name of await readdir(file)) await visit(path.join(file, name), path.join(relative, name));
    }
    if (!byPath.has(relative)) return;
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      | (info.isDirectory() ? constants.O_DIRECTORY : 0));
    try {
      const opened = await handle.stat();
      if (!opened.isDirectory() && !opened.isFile()) throw new Error("Cannot restore special file permissions.");
      await handle.chmod(byPath.get(relative));
    } finally {
      await handle.close();
    }
  }
  await visit(directory, "");
}
