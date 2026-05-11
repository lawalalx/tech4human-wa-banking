import { Workspace, LocalFilesystem, LocalSandbox } from "@mastra/core/workspace";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// __dirname = src/mastra  →  two levels up = project root (tech4human-wa-banking/)
const projectRoot = path.resolve(__dirname, "../../");

/**
 * Mastra Workspace for Tech4Human WhatsApp Banking Platform.
 *
 * - LocalFilesystem: Read/write files in the workspace directory
 *   (audit exports, customer documents, reports)
 * - LocalSandbox: Execute shell commands for administrative tasks
 * - Skills: All skills under the /skills directory are available to agents
 */

export const bankingWorkspace = new Workspace({
  filesystem: new LocalFilesystem({
    basePath: path.join(projectRoot, "workspace"),
  }),

  sandbox: new LocalSandbox({
    workingDirectory: path.join(projectRoot, "workspace"),
  }),

  // ✅ REQUIRED for SKILL.md system
  skills: ["skills"],

  // (optional but recommended for large banking flows)
  bm25: true,

  // (optional) improves skill + doc discovery
  autoIndexPaths: ["skills"],
});
