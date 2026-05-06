import express from "express";
import multer from "multer";
import fs from "fs-extra";
import { v4 as uuidv4 } from "uuid";
import { processAndStore } from "../process-and-store.js";
import { insertDoc, BANK_ID } from "../db.js";
import { ALLOWED_EXTENSIONS, MAX_FILE_SIZE_BYTES } from "../ingest-files.js";

const router = express.Router();

// Multer: temp files written to /uploads/<bank_id>/ for isolation
const upload = multer({
  dest: `uploads/${BANK_ID}/`,
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = file.originalname.split(".").pop()?.toLowerCase();
    if (!ext || !ALLOWED_EXTENSIONS.includes(ext)) {
      return cb(
        new Error(
          `Unsupported file type: .${ext}. Allowed: ${ALLOWED_EXTENSIONS.join(", ")}`
        )
      );
    }
    cb(null, true);
  },
});

/**
 * POST /api/kb/upload
 *
 * Upload one or more documents into the knowledge base.
 * Supports multipart file upload OR raw text body.
 * Each doc is chunked, embedded, and upserted into the tenant's vector index.
 *
 * Multi-tenant: documents are isolated by bank_id (BANK_ID env var).
 */
router.post(
  "/",
  upload.array("files"),
  async (req, res) => {
    try {
      const { text, title, category, language } = req.body as {
        text?: string;
        title?: string;
        category?: string;
        language?: string;
      };
      const files = req.files as Express.Multer.File[] | undefined;

      if ((!files || files.length === 0) && !text?.trim()) {
        return res.status(400).json({ success: false, error: "Provide either files or text body" });
      }
      if (files && files.length > 0 && text?.trim()) {
        return res.status(400).json({ success: false, error: "Provide files OR text, not both" });
      }

      // Build a normalised list of inputs
      const inputs: Array<{
        filePath: string;
        originalName: string;
        size?: number;
        isTemp: boolean;
      }> = [];

      if (text?.trim()) {
        const tmpPath = `uploads/${BANK_ID}/text_${Date.now()}.txt`;
        await fs.outputFile(tmpPath, text.trim());
        inputs.push({
          filePath: tmpPath,
          originalName: title ? `${title}.txt` : `text_${Date.now()}.txt`,
          isTemp: true,
        });
      } else if (files) {
        for (const file of files) {
          inputs.push({
            filePath: file.path,
            originalName: file.originalname,
            size: file.size,
            isTemp: false,
          });
        }
      }

      const results = [];
      const errors: string[] = [];

      for (const inp of inputs) {
        const docId = uuidv4();
        try {
          const result = await processAndStore({
            filePath: inp.filePath,
            docId,
            originalName: inp.originalName,
            category: category ?? "general",
            bankId: BANK_ID,
          });

          await insertDoc({
            docId,
            bankId: BANK_ID,
            title: title ?? undefined,
            originalName: inp.originalName,
            filePath: inp.filePath,
            category: category ?? "general",
            language: language ?? "en",
            size: inp.size,
            chunkCount: result.totalChunks,
          });

          results.push(result);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`${inp.originalName}: ${msg}`);
        } finally {
          if (inp.isTemp) await fs.remove(inp.filePath).catch(() => {});
        }
      }

      const status = results.length > 0 ? 200 : 400;
      return res.status(status).json({
        success: results.length > 0,
        bankId: BANK_ID,
        indexed: results.length,
        failed: errors.length,
        results,
        errors: errors.length ? errors : undefined,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Upload failed";
      console.error("[KB Upload] Error:", err);
      return res.status(500).json({ success: false, error: msg });
    }
  }
);

export default router;
