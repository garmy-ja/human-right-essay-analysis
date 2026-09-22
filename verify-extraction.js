import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function normalizeText(text) {
  if (!text) return "";
  // Remove whitespace and newlines for strict content comparison
  return text.replace(/\\s+/g, "").trim();
}

async function verifyExtraction() {
  const db = new Database(path.join(__dirname, 'essays.db'));
  const essays = db.prepare('SELECT id, title, body, raw_text FROM essays').all();

  console.log(`Verifying ${essays.length} essays...`);

  let issues = 0;
  let totalVerified = 0;

  for (const essay of essays) {
    totalVerified++;
    const { id, title, body, raw_text } = essay;

    if (!raw_text) {
      console.error(`[ID ${id}] Missing raw_text.`);
      issues++;
      continue;
    }

    // Check Title
    if (title) {
      const normTitle = normalizeText(title);
      const normRaw = normalizeText(raw_text);
      if (!normRaw.includes(normTitle)) {
        console.warn(`[ID ${id}] Title mismatch: Extracted title not found in raw text.`);
        console.warn(`  Extracted: ${title}`);
        issues++;
      }
    }

    // Check Body
    if (body) {
      const normBody = normalizeText(body);
      const normRaw = normalizeText(raw_text);
      if (!normRaw.includes(normBody)) {
        console.warn(`[ID ${id}] Body mismatch: Extracted body not found in raw text (possible LLM modification).`);
        // For body, we can provide more detail if it's a long text
        issues++;
      }
    }
  }

  console.log(`\nVerification complete.`);
  console.log(`Total checked: ${totalVerified}`);
  console.log(`Issues found: ${issues}`);

  if (issues === 0) {
    console.log('✅ All extractions are faithful to the original text.');
  } else {
    console.log('❌ Some extractions may have been modified by the LLM.');
  }
}

verifyExtraction().catch(console.error);
