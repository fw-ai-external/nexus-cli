// Preload (`node --import`) that kills the process the moment it is about to
// rename a file onto NEXUS_TEST_CRASH_BEFORE_WRITE, standing in for a crash
// between two awaited writes.
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

const target = process.env.NEXUS_TEST_CRASH_BEFORE_WRITE;
if (target) {
  const rename = fsPromises.rename;
  fsPromises.rename = async (from, to) => {
    if (String(to) === target) {
      process.kill(process.pid, "SIGKILL");
    }
    return rename(from, to);
  };
  syncBuiltinESMExports();
}
