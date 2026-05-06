import express from "express";
import fs from "fs-extra";
import { getAllDocs, getDocById, deleteDocRecord, getDocCountByCategory, BANK_ID } from "../db.js";
import { safeDeleteByDocId } from "../process-and-store.js";

const router = express.Router();

/**
 * GET /api/kb/docs
 * List all knowledge-base documents for this bank tenant.
 */
router.get("/", async (_req, res) => {
  try {
    const docs = await getAllDocs(BANK_ID);
    const categories = await getDocCountByCategory(BANK_ID);
    return res.json({
      success: true,
      bankId: BANK_ID,
      count: docs.length,
      docs,
      summary: { byCategory: categories },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to list docs";
    return res.status(500).json({ success: false, error: msg });
  }
});

/**
 * GET /api/kb/docs/:docId
 * Get metadata for a specific document.
 */
router.get("/:docId", async (req, res) => {
  try {
    const doc = await getDocById(req.params.docId, BANK_ID);
    if (!doc) return res.status(404).json({ success: false, error: "Document not found" });
    return res.json({ success: true, doc });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to get doc";
    return res.status(500).json({ success: false, error: msg });
  }
});

/**
 * DELETE /api/kb/docs/:docId
 * Delete a document: removes vectors, file, and metadata record.
 */
router.delete("/:docId", async (req, res) => {
  try {
    const { docId } = req.params;
    const doc = await getDocById(docId, BANK_ID);
    if (!doc) return res.status(404).json({ success: false, error: "Document not found" });

    // 1. Remove vectors from pgvector
    await safeDeleteByDocId(docId, BANK_ID);

    // 2. Remove file from disk (best-effort — file may have been cleaned up already)
    if (doc.file_path) await fs.remove(doc.file_path).catch(() => {});

    // 3. Remove metadata row
    await deleteDocRecord(docId, BANK_ID);

    return res.json({ success: true, message: `Document ${docId} deleted` });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to delete doc";
    return res.status(500).json({ success: false, error: msg });
  }
});

export default router;
