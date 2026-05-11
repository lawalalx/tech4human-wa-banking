import fs from "fs-extra";
import csvParser from "csv-parser";

/**
 * Extracts plain text from supported document formats.
 * Uses the `originalName` to determine file type (since temp paths have no extension).
 *
 * Supported: PDF, TXT, CSV, DOCX, DOC, XLSX, XLS, MD
 */
export async function extractText(filePath: string, originalName?: string): Promise<string> {
  const nameForExt = originalName ?? filePath;
  const ext = nameForExt.split(".").pop()?.toLowerCase();

  if (ext === "pdf") {
    // pdf-parse uses CommonJS — dynamic import handles ESM interop
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pdfParse = ((await import("pdf-parse")) as any).default;
    const buffer = await fs.readFile(filePath);
    const result = await pdfParse(buffer);
    return result.text;
  }

  if (ext === "txt" || ext === "md") {
    return fs.readFile(filePath, "utf-8");
  }

  if (ext === "csv") {
    return new Promise((resolve, reject) => {
      let result = "";
      fs.createReadStream(filePath)
        .pipe(csvParser())
        .on("data", (row: Record<string, unknown>) => {
          result += Object.values(row).join(" ") + "\n";
        })
        .on("end", () => resolve(result))
        .on("error", reject);
    });
  }

  if (ext === "docx" || ext === "doc") {
    const mammoth = await import("mammoth");
    const buffer = await fs.readFile(filePath);
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (ext === "xlsx" || ext === "xls") {
    const xlsxMod = await import("xlsx");
    const XLSX = (xlsxMod as any).default ?? xlsxMod;
    const buffer = await fs.readFile(filePath);
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const lines: string[] = [];
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" }) as Record<string, unknown>[];
      for (const row of rows) {
        lines.push(Object.values(row).join(" "));
      }
    }
    return lines.join("\n");
  }

  throw new Error(
    `Unsupported file type: .${ext}. Allowed: pdf, txt, md, csv, docx, doc, xlsx, xls`
  );
}

/** Allowed file extensions for upload validation */
export const ALLOWED_EXTENSIONS = ["pdf", "txt", "md", "csv", "docx", "doc", "xlsx", "xls"];
export const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB
