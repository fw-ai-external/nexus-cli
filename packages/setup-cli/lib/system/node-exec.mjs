import { existsSync } from "node:fs";

export function stableNodeExec(nodeExec, exists = existsSync) {
  const match = nodeExec.match(/^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/u);
  if (!match) return nodeExec;
  const stable = `${match[1]}/opt/${match[2]}/bin/node`;
  return exists(stable) ? stable : nodeExec;
}
