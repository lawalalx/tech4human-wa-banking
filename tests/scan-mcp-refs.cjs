// Temp diagnostic: scan src/ for remaining external-MCP references
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..", "src");
function walk(d) {
  let a = [];
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) a = a.concat(walk(p));
    else if (e.name.endsWith(".ts")) a.push(p);
  }
  return a;
}
const patterns = [
  /bankingMcpClient/,
  /@mastra\/mcp/,
  /MCP_SERVICE_URL/,
  /getBankingMcpToolsets/,
  /listToolsets/,
  /localhost:3001/,
];
let hits = 0;
for (const f of walk(ROOT)) {
  const lines = fs.readFileSync(f, "utf8").split("\n");
  lines.forEach((ln, i) => {
    if (patterns.some((re) => re.test(ln))) {
      hits++;
      console.log(`${f}:${i + 1}|${ln.trim().slice(0, 110)}`);
    }
  });
}
console.log(hits === 0 ? "CLEAN: no external MCP references remain in src/" : `TOTAL HITS: ${hits}`);
